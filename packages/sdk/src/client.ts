import {
  ActivatablePolicyStore,
  AuthorizationRequest,
  PolicySource,
  ValidationError,
  coerceIdentifier,
  parseAction,
} from "@uae/core";
import { DEFAULT_LIMITS, Evaluator, InMemoryRelationshipStore } from "@uae/evaluator";
import { InMemoryPolicyStore } from "@uae/policy";
import { ClientTransport, InProcessTransport } from "./transport.js";
import { CheckOutcome, ClientCheckOptions, ClientRequest, IsAllowedOptions } from "./types.js";

/**
 * Options for setting up an in-memory client.
 */
export interface InMemoryClientOptions {
  /**
   * Policy text or structured policy source to publish and activate.
   */
  readonly policy: string | PolicySource;
  /**
   * Initial baseline relationships.
   */
  readonly relationships?: readonly unknown[];
  /**
   * Optional evaluation limits overriding defaults.
   */
  readonly limits?: Partial<typeof DEFAULT_LIMITS>;
}

/**
 * Normalizes a client request into a validated {@link AuthorizationRequest}.
 * Throws {@link ValidationError} if subject, action, or resource is invalid.
 */
export function normalizeClientRequest(req: ClientRequest): AuthorizationRequest {
  const subject = coerceIdentifier(req.subject, "subject");
  const action = parseAction(req.action);
  const resource = coerceIdentifier(req.resource, "resource");

  if (req.context !== undefined) {
    if (Array.isArray(req.context)) {
      throw new ValidationError("context", "must be an object");
    }
    return { subject, action, resource, context: req.context };
  }

  return { subject, action, resource };
}

/**
 * High-level, stable TypeScript client for the Universal Authorization Engine (ADR-0016).
 */
export class AuthzClient {
  private readonly transport: ClientTransport;
  private readonly maxBatchSize: number;

  constructor(transport: ClientTransport, maxBatchSize: number = DEFAULT_LIMITS.maxBatchSize) {
    this.transport = transport;
    this.maxBatchSize = maxBatchSize;
  }

  /**
   * Create a client wrapping an in-process {@link Evaluator}.
   */
  static fromEvaluator(evaluator: Evaluator): AuthzClient {
    return new AuthzClient(new InProcessTransport(evaluator), evaluator.limits.maxBatchSize);
  }

  /**
   * Create an in-memory client initialized with policy and relationships.
   */
  static async inMemory(options: InMemoryClientOptions): Promise<AuthzClient> {
    // Typed as the core control-plane view so activation is awaited against the
    // contract (`void | Promise<void>`) rather than the in-memory class's sync
    // setter: a persistent backend's activation must be awaited, and the client
    // must not be written against the reference implementation (ADR-0005).
    const policyStore: ActivatablePolicyStore = new InMemoryPolicyStore();
    const policySource: PolicySource =
      typeof options.policy === "string"
        ? { source: options.policy, format: "text" }
        : options.policy;

    const published = await policyStore.publishPolicy(policySource);
    await policyStore.setActiveVersion(published.version);

    const relationshipStore = new InMemoryRelationshipStore();
    if (options.relationships !== undefined) {
      relationshipStore.addAll(options.relationships);
    }

    const evaluator = new Evaluator(
      options.limits !== undefined
        ? {
            policyStore,
            relationshipStore: relationshipStore.asRelationshipStore(),
            limits: options.limits,
          }
        : {
            policyStore,
            relationshipStore: relationshipStore.asRelationshipStore(),
          },
    );

    return AuthzClient.fromEvaluator(evaluator);
  }

  /**
   * Perform an authorization check, returning a discrete {@link CheckOutcome}:
   * either `{ outcome: "decision", decision }` or `{ outcome: "unavailable", error }`.
   *
   * Invalid requests throw {@link ValidationError} at the client boundary.
   */
  async check(request: ClientRequest, options?: ClientCheckOptions): Promise<CheckOutcome> {
    const normalized = normalizeClientRequest(request);
    return this.transport.check(normalized, options);
  }

  /**
   * Convenience boolean helper for authorization guards.
   *
   * - If outcome is "decision", returns `decision.allowed`.
   * - If outcome is "unavailable":
   *   - Defaults to throwing {@link AuthorizationUnavailableError}.
   *   - If `onUnavailable: "deny"` is passed, fails closed to `false`.
   *   - (Failing open is strictly disallowed per ADR-0016).
   */
  async isAllowed(request: ClientRequest, options?: IsAllowedOptions): Promise<boolean> {
    const outcome = await this.check(request, options);
    if (outcome.outcome === "decision") {
      return outcome.decision.allowed;
    }

    if (options?.onUnavailable === "deny") {
      return false;
    }

    throw outcome.error;
  }

  /**
   * Evaluate a batch of requests with per-item isolation.
   *
   * - Throws {@link ValidationError} if the batch size exceeds `maxBatchSize`
   *   or if any request in the batch is malformed.
   * - Returns an array of {@link CheckOutcome} matching the positional order of requests.
   */
  async checkBatch(
    requests: readonly ClientRequest[],
    options?: ClientCheckOptions,
  ): Promise<readonly CheckOutcome[]> {
    if (requests.length > this.maxBatchSize) {
      throw new ValidationError(
        "requests",
        `batch of ${String(requests.length)} exceeds maxBatchSize ${String(this.maxBatchSize)}`,
      );
    }

    const normalized = requests.map((req) => normalizeClientRequest(req));
    return this.transport.checkBatch(normalized, options);
  }
}
