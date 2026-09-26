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
  /** A query failed (constraint violation, bad SQL, corrupt row). */
  | "query_failed"
  /** The schema is missing or unmigrated. */
  | "schema_missing";

export function isPersistenceError(error: unknown): error is PersistenceError {
  return error instanceof PersistenceError;
}

/**
 * Classify a driver-level failure into a typed infrastructure error.
 *
 * A `SELECT` returning zero rows is a legitimate answer, never an error — only
 * a thrown driver error reaches here.
 */
export function persistenceError(operation: string, error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const reason: PersistenceErrorReason =
    code === "42P01" || code === "42703"
      ? "schema_missing"
      : code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT"
        ? "unavailable"
        : "query_failed";
  return new PersistenceError(reason, `${operation} failed: ${message}`, { cause: error });
}
