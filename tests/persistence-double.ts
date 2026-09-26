import type { PgQueryable, PgQueryExecutor } from "../packages/persistence/src/index.js";

/**
 * A recording `PgQueryable` double.
 *
 * The stores depend on the narrow `PgQueryable` interface rather than on `pg`
 * directly, so their SQL construction, error classification, and fail-closed
 * behaviour are unit-testable with no database present. This is what keeps the
 * persistence package honest in environments that have no Postgres at all.
 */
export interface Recorded {
  readonly sql: string;
  readonly values: readonly unknown[];
}

/**
 * Row supplier for {@link recordingDb}.
 *
 * Takes a fixed row list and returns it cast to the store's requested row
 * type. The double is a test seam, so a single documented cast is preferable
 * to threading a type parameter through every call site.
 */
export type RecordingHandler = (rows: readonly unknown[]) => { readonly rowCount?: number };

export function recordingDb(rows: readonly unknown[] = []): {
  db: PgQueryable;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const run: PgQueryExecutor["query"] = (sql, values = []) => {
    calls.push({ sql, values });
    return Promise.resolve({
      rows: rows as never,
      rowCount: rows.length,
    });
  };
  const executor: PgQueryable = {
    query: run,
    // Mirror the real adapter: a transaction issues BEGIN/COMMIT, so tests can
    // assert the isolation level actually requested (ADR-0018 S2).
    transaction: (iso, fn) => {
      const runTx = async () => fn(executor);
      return run(`BEGIN ISOLATION LEVEL ${iso}`)
        .then(runTx)
        .finally(() => run("COMMIT"));
    },
  };
  return { calls, db: executor };
}

/**
 * A `PgQueryable` whose *statements inside a transaction* fail with the given
 * driver error code.
 *
 * `transaction` opens successfully and hands `fn` an executor that always
 * fails, which is what a real driver does when the connection drops mid-query —
 * so the store's own error wrapping is what surfaces to the caller.
 */
export function failingDb(code: string, message: string): PgQueryable {
  const reject = (): Promise<never> => Promise.reject(Object.assign(new Error(message), { code }));
  const failing: PgQueryExecutor = { query: () => reject() };
  return {
    query: () => reject(),
    transaction: <T>(_iso: string, fn: (tx: PgQueryExecutor) => Promise<T>): Promise<T> =>
      fn(failing),
  };
}
