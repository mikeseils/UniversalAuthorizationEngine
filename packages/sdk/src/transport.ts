import { AuthorizationRequest } from "@uae/core";
import { Evaluator } from "@uae/evaluator";
import { PolicyStoreError } from "@uae/policy";
import { AuthorizationUnavailableError, UnavailableReason } from "./errors.js";
import { CheckOutcome, ClientCheckOptions } from "./types.js";

/**
 * Transport interface abstracting the communication with the engine data plane.
 * Implementations exist for in-process (Phase 5) and remote/network (Phase 8).
 */
export interface ClientTransport {
  check(request: AuthorizationRequest, options?: ClientCheckOptions): Promise<CheckOutcome>;
  checkBatch(
    requests: readonly AuthorizationRequest[],
    options?: ClientCheckOptions,
  ): Promise<readonly CheckOutcome[]>;
}

/**
 * In-process client transport wrapping a local {@link Evaluator}.
 */
export class InProcessTransport implements ClientTransport {
  private readonly evaluator: Evaluator;

  constructor(evaluator: Evaluator) {
    this.evaluator = evaluator;
  }

  async check(request: AuthorizationRequest, options?: ClientCheckOptions): Promise<CheckOutcome> {
    try {
      const decision = await this.evaluator.check(
        request,
        options?.explanation !== undefined ? { explanation: options.explanation } : undefined,
      );
      return { outcome: "decision", decision };
    } catch (error) {
      return { outcome: "unavailable", error: toUnavailableError(error) };
    }
  }

  async checkBatch(
    requests: readonly AuthorizationRequest[],
    options?: ClientCheckOptions,
  ): Promise<readonly CheckOutcome[]> {
    const outcomes: CheckOutcome[] = [];
    for (const request of requests) {
      outcomes.push(await this.check(request, options));
    }
    return outcomes;
  }
}

/**
 * Classifies an evaluation exception into a typed AuthorizationUnavailableError.
 */
export function toUnavailableError(error: unknown): AuthorizationUnavailableError {
  if (error instanceof AuthorizationUnavailableError) {
    return error;
  }

  let reason: UnavailableReason = "internal_error";
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof PolicyStoreError || /policy store/i.test(message)) {
    reason = "policy_store_error";
  } else if (/relationship store/i.test(message)) {
    reason = "relationship_store_error";
  }

  return new AuthorizationUnavailableError(reason, message, error);
}
