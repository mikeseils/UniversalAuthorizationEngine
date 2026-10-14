/**
 * `pg` adapter — the only file in the repository that imports `pg`.
 *
 * Everything else in this package depends on the narrow `PgQueryable`
 * interface, so the stores are testable without a live database and the
 * driver stays an implementation detail (ADR-0005).
 */
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { PersistenceError, persistenceError } from "./errors.js";
import type { PgQueryExecutor, PgQueryable, PgQueryResult } from "./pool.js";

/** Wait for a pooled client before failing (5s) — `pg`'s default never times out. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
/** Close an idle client after this long (30s). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Connection options for {@link createPgQueryable}. */
export interface PgConnectionOptions {
  readonly connectionString: string;
  /** Max pooled clients. Defaults to a small, predictable number. */
  readonly max?: number;
  /**
   * Milliseconds to wait for a pooled client before failing.
   *
   * Defaults to {@link DEFAULT_CONNECTION_TIMEOUT_MS}: `pg`'s own default is to
   * wait **forever**, which turns an unreachable database into a hung request
   * rather than an `AUTHZ_UNAVAILABLE` the caller can react to.
   */
  readonly connectionTimeoutMillis?: number;
  /** Milliseconds an idle client is kept before being closed. Default 30 000. */
  readonly idleTimeoutMillis?: number;
  /**
   * Server-side statement timeout in milliseconds; `0`/omitted disables it.
   *
   * A bound on the server is the only way to stop one pathological query from
   * occupying a pool slot indefinitely; it is surfaced as a query failure
   * (`query_failed`), never as an empty result (ADR-0018 S4).
   */
  readonly statementTimeoutMillis?: number;
  /**
   * Sink for **pool-level** errors: an idle client dropped by the server, a
   * network partition, a failed relay.
   *
   * Required reading: node-postgres emits an `error` event on the pool, and an
   * unhandled `error` event terminates the process. A pool that can kill its
   * host is not acceptable for a persistence layer, so the listener is always
   * attached (see {@link attachPoolErrorHandler}) and the default sink is
   * `process.emitWarning` — visible, never fatal, never silent.
   */
  readonly onError?: (error: PersistenceError) => void;
}

/**
 * Register a pool-level `error` handler.
 *
 * Takes the narrow `on` shape rather than a `Pool` so the wiring is testable
 * with a fake — the handler is the only thing standing between a dropped idle
 * client and an unhandled `error` event that ends the process, so it must not
 * be reachable only through `pg`.
 */
export function attachPoolErrorHandler(
  source: PoolErrorSource,
  onError?: (error: PersistenceError) => void,
): void {
  source.on("error", (error: unknown) => {
    handlePoolError(error, onError);
  });
}

/**
 * Classify and report a pool-level error.
 *
 * Exported (and pure) so the classification and the "never throw, never stay
 * silent" contract are unit-testable without a database. A pool error is by
 * definition a disturbance of the connection itself, so the default sink is
 * `process.emitWarning`: an operator sees it, and no caller is left with a
 * crashed process for a failure it never awaited.
 */
export function handlePoolError(
  error: unknown,
  onError?: (error: PersistenceError) => void,
): PersistenceError {
  const failure = persistenceError("pool", error);
  if (onError !== undefined) {
    onError(failure);
    return failure;
  }
  process.emitWarning(failure.message, { type: failure.name });
  return failure;
}

/** The slice of a pool (or pool-like test double) this module needs. */
export interface PoolErrorSource {
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/**
 * Normalize a driver result into the {@link PgQueryResult} contract.
 *
 * node-postgres returns an **array** of results when the statement text holds
 * more than one statement (the simple-query path — which is what migrations
 * use). Treating that array as a single result makes `.rows` undefined, so this
 * helper unwraps it to the final statement's result. Single statements — every
 * query the stores issue — pass through unchanged.
 *
 * Pure and exported so the multi-statement path is unit-testable without a
 * live database (the recording double only ever produces single results, which
 * is exactly how this bug shipped once).
 */
export function normalizeQueryResult<TRow>(raw: unknown): PgQueryResult<TRow> {
  const result = (Array.isArray(raw) ? raw[raw.length - 1] : raw) as
    { rows?: readonly TRow[]; rowCount?: number | null } | undefined;
  const rows = Array.isArray(result?.rows) ? (result.rows as TRow[]) : [];
  return { rows, rowCount: result?.rowCount ?? rows.length };
}

/**
 * Build the `pg` pool configuration (pure, so the defaults are testable).
 *
 * Every timeout here is deliberate: `pg` waits forever by default, which turns
 * an unreachable database into a hung authorization request instead of the
 * `AUTHZ_UNAVAILABLE` the SDK contract requires.
 */
export function poolConfig(options: PgConnectionOptions): PoolConfig {
  return {
    connectionString: options.connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(options.statementTimeoutMillis === undefined || options.statementTimeoutMillis === 0
      ? {}
      : { statement_timeout: options.statementTimeoutMillis }),
  };
}

/**
 * Wrap a `pg` pool in the `PgQueryable` interface, including transaction
 * support so stores can bind a `REPEATABLE READ` snapshot (ADR-0018 S2).
 */
export function createPgQueryable(options: PgConnectionOptions): PgQueryable & {
  end(): Promise<void>;
} {
  const pool = new Pool(poolConfig(options));
  // Never optional: without a listener, a pool-level `error` event is unhandled
  // and takes the process down (see PgConnectionOptions.onError).
  attachPoolErrorHandler(pool, options.onError);

  const wrapExecutor = (executor: Pool | PoolClient): PgQueryExecutor => ({
    query: async <TRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PgQueryResult<TRow>> => {
      try {
        const result = await executor.query(text, values as unknown[]);
        return normalizeQueryResult<TRow>(result);
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
