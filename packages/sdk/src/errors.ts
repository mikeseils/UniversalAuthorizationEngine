export { PolicyNotFoundError, ValidationError } from "@uae/core";

/**
 * Reason classifications for why the engine was unavailable.
 */
export type UnavailableReason =
  "policy_store_error" | "relationship_store_error" | "transport_error" | "internal_error";

/**
 * Error thrown or represented when the authorization engine could not produce
 * a decision due to an infrastructure or communication failure (ADR-0016).
 *
 * This is fundamentally distinct from an authorization denial (`allowed: false`).
 */
export class AuthorizationUnavailableError extends Error {
  public readonly reason: UnavailableReason;
  public override readonly cause?: unknown;

  constructor(reason: UnavailableReason, message: string, cause?: unknown) {
    super(`AUTHZ_UNAVAILABLE (${reason}): ${message}`);
    this.name = "AuthorizationUnavailableError";
    this.reason = reason;
    this.cause = cause;
  }
}
