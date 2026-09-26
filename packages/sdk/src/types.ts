import {
  Action,
  AuthorizationContext,
  AuthorizationDecision,
  ExplanationLevel,
  Identifier,
} from "@uae/core";

/**
 * An identifier reference at the client boundary (ADR-0015):
 * either a string `"user:alice"` or structured `{ type: "user", id: "alice" }`.
 */
export type SubjectRef = string | Identifier;
export type ResourceRef = string | Identifier;

/**
 * Ergonomic authorization request at the client boundary (ADR-0015, ADR-0016).
 */
export interface ClientRequest {
  readonly subject: SubjectRef;
  readonly action: Action;
  readonly resource: ResourceRef;
  readonly context?: AuthorizationContext;
}

/**
 * Check options for client evaluation.
 */
export interface ClientCheckOptions {
  readonly explanation?: ExplanationLevel;
}

/**
 * A successful authorization evaluation outcome produced by the engine.
 */
export interface AuthorizationDecisionOutcome {
  readonly outcome: "decision";
  readonly decision: AuthorizationDecision;
}

/**
 * An infrastructure failure where the authorization engine could not answer (ADR-0016).
 * Distinct from a DENY.
 */
export interface AuthorizationUnavailableOutcome {
  readonly outcome: "unavailable";
  readonly error: import("./errors.js").AuthorizationUnavailableError;
}

/**
 * The discrete, typed outcome of an authorization check (ADR-0016).
 */
export type CheckOutcome = AuthorizationDecisionOutcome | AuthorizationUnavailableOutcome;

/**
 * Fallback policy options when calling `isAllowed`.
 */
export interface IsAllowedOptions extends ClientCheckOptions {
  /**
   * If set to "deny", an unavailable engine outcome will return `false`
   * (fail-closed at the application level).
   * If omitted, `isAllowed` throws `AuthorizationUnavailableError`.
   */
  readonly onUnavailable?: "deny";
}
