/**
 * `pg` adapter — the only file in the repository that imports `pg`.
 *
 * Everything else in this package depends on the narrow `PgQueryable`
 * interface, so the stores are testable without a live database and the
 * driver stays an implementation detail (ADR-0005).
 */
import { Pool, type PoolClient } from "pg";
import { persistenceError } from "./errors.js";
import type { PgQueryExecutor, PgQueryable, PgQueryResult } from "./pool.js";

/** Connection options for {@link createPgQueryable}. */
export interface PgConnectionOptions {
  readonly connectionString: string;
  /** Max pooled clients. Defaults to a small, predictable number. */
  readonly max?: number;
}

/**
 * Wrap a `pg` pool in the `PgQueryable` interface, including transaction
 * support so stores can bind a `REPEATABLE READ` snapshot (ADR-0018 S2).
 */
export function createPgQueryable(options: PgConnectionOptions): PgQueryable & {
  end(): Promise<void>;
} {
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
  });

  const wrapExecutor = (executor: Pool | PoolClient): PgQueryExecutor => ({
    query: async <TRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PgQueryResult<TRow>> => {
      try {
        const result = await executor.query(text, values as unknown[]);
        return { rows: result.rows as TRow[], rowCount: result.rowCount ?? result.rows.length };
      } catch (error) {
        throw persistenceError("query", error);
      }
    },
  });

  return {
    ...wrapExecutor(pool),
    transaction: async <T>(
      isolation: "REPEATABLE READ" | "READ COMMITTED",
      fn: (tx: PgQueryExecutor) => Promise<T>,
    ): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        const result = await fn(wrapExecutor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A rollback failure must not mask the original error.
        }
        throw error instanceof Error ? error : persistenceError("transaction", error);
      } finally {
        client.release();
      }
    },
    end: async () => {
      await pool.end();
    },
  };
}
