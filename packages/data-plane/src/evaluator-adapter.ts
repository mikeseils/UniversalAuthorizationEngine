import { Evaluator } from "@uae/evaluator";
import {
  AuthorizationDecision,
  type AuthorizationRequest,
  coerceIdentifier,
  parseAction,
} from "@uae/core";

/**
 * Adapts the in-process {@link Evaluator} to the data-plane HTTP request/response
 * shapes. Keeps the evaluator pure — no I/O, no logging, no HTTP here.
 */
export class EvaluatorAdapter {
  constructor(private readonly evaluator: Evaluator) {}

  /** Evaluate a single check request. */
  async check(request: ClientRequest): Promise<CheckOutcome> {
    try {
      const normalized = normalizeRequest(request);
      const decision = await this.evaluator.check(normalized);
      return { outcome: "decision", decision };
    } catch (error) {
      return {
        outcome: "unavailable",
        error: new AuthorizationUnavailableError(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }

  /** Evaluate a batch of check requests, one at a time. */
  async checkBatch(requests: readonly ClientRequest[]): Promise<CheckOutcome[]> {
    const outcomes: CheckOutcome[] = [];
    for (const request of requests) {
      outcomes.push(await this.check(request));
    }
    return outcomes;
  }
}

/** Wire-shape request: subject/resource may be strings or { type, id }. */
export interface ClientRequest {
  readonly subject: string | { readonly type: string; readonly id: string };
  readonly action: string;
  readonly resource: string | { readonly type: string; readonly id: string };
  readonly context?: Record<string, string | number | boolean>;
}

/** Wire-shape outcome: decision vs unavailable, matching the SDK taxonomy (ADR-0016). */
export type CheckOutcome =
  | { readonly outcome: "decision"; readonly decision: AuthorizationDecision }
  | { readonly outcome: "unavailable"; readonly error: AuthorizationUnavailableError };

export class AuthorizationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationUnavailableError";
  }
}

function normalizeRequest(req: ClientRequest): AuthorizationRequest {
  return {
    subject: toIdentifier(req.subject, "subject"),
    action: parseAction(req.action),
    resource: toIdentifier(req.resource, "resource"),
    ...(req.context === undefined ? {} : { context: req.context }),
  };
}

function toIdentifier(
  value: string | { readonly type: string; readonly id: string },
  label: string,
): { readonly type: string; readonly id: string } {
  if (typeof value === "string") {
    return coerceIdentifier(value, label);
  }
  return value;
}
