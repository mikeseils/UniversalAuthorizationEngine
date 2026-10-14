/**
 * Typed infrastructure error for persistent stores.
 *
 * Distinct from a DENY and from a caller error (ADR-0010, ADR-0018 S4): a
 * storage failure must surface as `AUTHZ_UNAVAILABLE` at the SDK boundary, not
 * as an empty result set. Returning `[]` for "the database is down" would turn
 * an outage into a silent, universal denial — and, in any code path that
 * treated absence as absence, potentially into a wrong ALLOW.
 */
export class PersistenceError extends Error {
  /** Machine-readable cause, safe to log (never includes credentials). */
  public readonly reason: PersistenceErrorReason;

  constructor(reason: PersistenceErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersistenceError";
    this.reason = reason;
  }
}

export type PersistenceErrorReason =
  /** The database could not be reached or the connection was lost. */
  | "unavailable"
  /** The query or connection timed out (server statement_timeout or client connectionTimeoutMillis). */
  | "timeout"
  /** A query failed (constraint violation, bad SQL, corrupt row). */
  | "query_failed"
  /** The schema is missing or unmigrated. */
  | "schema_missing";

/**
 * The store could not be reached, or the connection was lost mid-flight.
 *
 * At the class level these subclasses exist so callers can branch on
 * `instanceof` without string-matching a reason, which is what ADR-0020
 * requires. The inherited `reason` field stays authoritative for logging.
 */
export class StoreUnavailableError extends PersistenceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("unavailable", message, options);
    this.name = "StoreUnavailableError";
  }
}

/**
 * A query or a connection attempt exceeded its deadline.
 *
 * A timeout is separated from unavailability because the two demand different
 * operator responses: a timeout is a capacity/latency problem (raise a bound,
 * add an index, scale the pool), while unavailability is a connectivity problem
 * (restart the server, fix the network). Both are fail-closed, but neither is a
 * DENY, and conflating them turns a tuning signal into an incident.
 */
export class StoreTimeoutError extends PersistenceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("timeout", message, options);
    this.name = "StoreTimeoutError";
  }
}

export function isPersistenceError(error: unknown): error is PersistenceError {
  return error instanceof PersistenceError;
}

/**
 * Classify a driver-level failure into a typed infrastructure error.
 *
 * A `SELECT` returning zero rows is a legitimate answer, never an error — only
 * a thrown driver error reaches here. The mapping is normative (ADR-0020):
 *
 * | Driver signal                        | Reason           | Typed error             |
 * | ------------------------------------ | ---------------- | ----------------------- |
 * | `42P01`, `42703`                     | `schema_missing` | `PersistenceError`      |
 * | `57014`, `ETIMEDOUT`, /timeout/i     | `timeout`        | `StoreTimeoutError`     |
 * | `ECONN*`, `EPIPE`, `ENOTFOUND`, `08xxx`, "connection … terminated" | `unavailable` | `StoreUnavailableError` |
 * | anything else                        | `query_failed`   | `PersistenceError`      |
 *
 * Order matters: a server-side `statement_timeout` arrives as `57014`, and it
 * must not be mistaken for a lost connection.
 */
export function persistenceError(operation: string, error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const detail = `${operation} failed: ${message}`;
  const options = { cause: error };

  if (code === "42P01" || code === "42703") {
    return new PersistenceError("schema_missing", detail, options);
  }
  if (code === "57014" || code === "ETIMEDOUT" || /timeout/i.test(message)) {
    return new StoreTimeoutError(detail, options);
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "08000" ||
    code === "08003" ||
    code === "08006" ||
    code === "08001" ||
    code === "57P01" ||
    /connection.*(terminated|closed|ended|refused)/i.test(message)
  ) {
    return new StoreUnavailableError(detail, options);
  }
  return new PersistenceError("query_failed", detail, options);
}
