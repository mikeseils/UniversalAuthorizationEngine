import { AuthorizationRequest, Identifier, PolicyNotFoundError, ValidationError } from "@uae/core";
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
        options === undefined
          ? undefined
          : {
              ...(options.explanation !== undefined ? { explanation: options.explanation } : {}),
              ...(options.policyVersion !== undefined
                ? { policyVersion: options.policyVersion }
                : {}),
            },
      );
      return { outcome: "decision", decision };
    } catch (error) {
      // A pinned version that does not exist is a *caller* error, not an
      // infrastructure failure (ADR-0019). Reporting it as `unavailable` would
      // tell the application the engine is broken when it asked for something
      // that never existed — and would let a fail-closed path mask a bug.
      if (error instanceof PolicyNotFoundError) {
        throw error;
      }
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
 * HTTP client transport wrapping a remote data-plane node (Phase 8).
 *
 * Sends `AuthorizationRequest`s as JSON to `POST /check` and `POST
 * /checkBatch`. Maps HTTP 503 to `AUTHZ_UNAVAILABLE`, 4xx to `ValidationError`,
 * and network/infrastructure failures to `AUTHZ_UNAVAILABLE` with reason
 * `transport_error`.
 */
export class HttpTransport implements ClientTransport {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  }

  async check(request: AuthorizationRequest, _options?: ClientCheckOptions): Promise<CheckOutcome> {
    return this.request("/check", { method: "POST", body: JSON.stringify(requestToWire(request)) });
  }

  async checkBatch(
    requests: readonly AuthorizationRequest[],
    _options?: ClientCheckOptions,
  ): Promise<readonly CheckOutcome[]> {
    const requestBody = JSON.stringify(requests.map(requestToWire));
    const res = await fetch(`${this.baseUrl}/checkBatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    if (res.status === 503) {
      const batch = (await res.json()) as Array<{
        outcome: string;
        error?: { message: string; reason?: string };
      }>;
      return batch.map((b) => ({
        outcome: "unavailable",
        error: new AuthorizationUnavailableError(
          (b.error?.reason ?? "transport_error") as UnavailableReason,
          b.error?.message ?? "engine unavailable",
        ),
      }));
    }

    if (!res.ok) {
      const errorBody = (await res.json()) as { error?: { message: string } };
      throw new ValidationError(
        "request",
        errorBody.error?.message ?? `HTTP ${String(res.status)}`,
      );
    }

    const batch = (await res.json()) as Array<{
      outcome: string;
      decision: unknown;
    }>;
    if (!batch.every((b) => b.outcome === "decision")) {
      throw new ValidationError("response", "unexpected response shape from data plane");
    }
    return batch.map((b) => ({ outcome: "decision", decision: b.decision as never }));
  }

  private async request(path: string, init: RequestInit): Promise<CheckOutcome> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
        body: init.body,
      } as RequestInit);

      if (res.status === 503) {
        const body = (await res.json()) as Record<string, unknown>;
        const error = body.error as { message?: string; reason?: string } | undefined;
        return {
          outcome: "unavailable",
          error: new AuthorizationUnavailableError(
            (error?.reason ?? "transport_error") as UnavailableReason,
            error?.message ?? "engine unavailable",
          ),
        };
      }

      if (!res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        const error = body.error as { message?: string } | undefined;
        throw new ValidationError("request", error?.message ?? `HTTP ${String(res.status)}`);
      }

      const body = (await res.json()) as Record<string, unknown>;
      if (body.outcome !== "decision") {
        throw new ValidationError("response", "unexpected response shape from data plane");
      }
      return { outcome: "decision", decision: body.decision as never };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      return {
        outcome: "unavailable",
        error: new AuthorizationUnavailableError(
          "transport_error",
          error instanceof Error ? error.message : String(error),
          error,
        ),
      };
    }
  }
}

/**
 * Convert an {@link AuthorizationRequest} to the wire format used by the data
 * plane: subject/resource as `type:id` strings.
 */
function requestToWire(request: AuthorizationRequest): {
  readonly subject: string;
  readonly action: string;
  readonly resource: string;
  readonly context?: Record<string, string | number | boolean>;
} {
  const toWireId = (value: string | Identifier): string =>
    typeof value === "string" ? value : `${value.type}:${value.id}`;
  return {
    subject: toWireId(request.subject),
    action: request.action,
    resource: toWireId(request.resource),
    ...(request.context === undefined
      ? {}
      : { context: request.context as Record<string, string | number | boolean> }),
  };
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
