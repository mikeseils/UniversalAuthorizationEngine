/**
 * Minimal query interface the stores depend on.
 *
 * The stores never import `pg` directly. They accept this narrow executor, so
 * the conformance suite can drive them against a real database, and unit tests
 * can drive them against a recording double. `pg`'s `Pool` satisfies it.
 */
export interface PgQueryResult<TRow> {
  readonly rows: TRow[];
  readonly rowCount: number;
}

export interface PgQueryExecutor {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TRow>>;
}

/**
 * A client that can run queries, plus a way to begin a transaction.
 *
 * `withSnapshot` (ADR-0018 S2) requires this: one check must read one coherent
 * state, so every read of a single evaluation binds to a `REPEATABLE READ`
 * transaction rather than running as independent statements.
 */
export interface PgQueryable extends PgQueryExecutor {
  /**
   * Run `fn` inside a transaction, committing on success, rolling back on throw.
   *
   * `transaction` is what makes ADR-0018 S2 (snapshot consistency) possible:
   * every read of a single evaluation binds to a `REPEATABLE READ` transaction
   * rather than running as independent statements.
   */
  transaction<T>(
    isolation: "REPEATABLE READ" | "READ COMMITTED",
    fn: (tx: PgQueryExecutor) => Promise<T>,
  ): Promise<T>;
}

/**
 * Read a JSON column, tolerating drivers that hand back a parsed object instead
 * of text. The result is `unknown` on purpose: policy artifacts are validated
 * structurally after loading, never trusted because of their column type.
 */
export function readJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}
