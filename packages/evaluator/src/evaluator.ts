import {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationRequest,
  Identifier,
  PolicyNotFoundError,
  PolicyStore,
  ValidationError,
  VersionedPolicy,
  coerceIdentifier,
  parseAction,
} from "@uae/core";
import { isCompiledArtifactShape, PolicyDefinition, PolicyExpression } from "@uae/policy";
import { finalize } from "./finalize.js";
import { EvalState, makeEvaluatorFn } from "./internal-eval.js";
import { DEFAULT_LIMITS, EvaluationLimits, EvaluationObserver } from "./limits.js";
import { permissionName } from "./permission-name.js";
import { type CheckOptions, type EvaluatorDependencies } from "./types.js";

export type { EvaluationLimits, EvaluationObserver } from "./limits.js";
export { DEFAULT_LIMITS } from "./limits.js";
export { permissionName, pruneExplanation } from "./permission-name.js";
export type { CheckOptions, EvaluatorDependencies } from "./types.js";

export class Evaluator {
  private readonly policyStore: PolicyStore;
  private readonly relationshipStore: import("@uae/core").RelationshipStore;
  public readonly limits: EvaluationLimits;
  private observer?: EvaluationObserver;
  private readonly evaluate = makeEvaluatorFn();

  constructor(deps: EvaluatorDependencies) {
    this.policyStore = deps.policyStore;
    this.relationshipStore = deps.relationshipStore;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    if (deps.observer !== undefined) {
      this.observer = deps.observer;
    }
  }

  /**
   * Evaluate one request. Subjects/resources may be given as `type:id` strings
   * or parsed identifiers. Malformed requests throw at the boundary
   * (`ValidationError`); infrastructure failures propagate typed errors; every
   * evaluated outcome is fail-closed (ADR-0010).
   */
  async check(
    request: AuthorizationRequest,
    options?: CheckOptions,
  ): Promise<AuthorizationDecision> {
    const subject = coerceIdentifier(request.subject, "subject");
    const action = parseAction(request.action);
    const resource = coerceIdentifier(request.resource, "resource");
    const context: AuthorizationContext = request.context ?? {};
    this.emit("normalize", `${action} on ${resource.type}:${resource.id}`);

    const policy = await this.loadPolicy(options?.policyVersion);
    this.emit("policy:loaded", policy.version);

    const result = await this.evaluateArtifact(policy, subject, action, resource, context);
    return finalize(result, policy.version, action, resource, options?.explanation ?? "none");
  }

  /**
   * Sequential batch (Phase 2/7) — concurrency is a performance-phase concern.
   *
   * Failure semantics, stated precisely because they are security-relevant:
   * *evaluation outcomes* are per-item and each is independently fail-closed, but
   * an **infrastructure failure** (or a malformed request) rejects the whole
   * batch. Returning a decision list that silently substituted DENY for "the
   * engine could not answer" would destroy the DENIED-vs-AUTHZ_UNAVAILABLE
   * distinction that the failure-modes design requires, and fabricating an ALLOW
   * is never acceptable. Per-item unavailability therefore needs a result type
   * that `core` deliberately does not have — it belongs to the SDK (ADR-0016).
   */
  async checkBatch(
    requests: readonly AuthorizationRequest[],
    options?: CheckOptions,
  ): Promise<AuthorizationDecision[]> {
    if (requests.length > this.limits.maxBatchSize) {
      throw new ValidationError(
        "requests",
        `batch of ${String(requests.length)} exceeds maxBatchSize ${String(this.limits.maxBatchSize)}`,
      );
    }
    const decisions: AuthorizationDecision[] = [];
    for (const request of requests) {
      decisions.push(await this.check(request, options));
    }
    return decisions;
  }

  /**
   * Resolve the policy artifact to evaluate (ADR-0019).
   *
   * Pinning is opt-in and the default path is unchanged. An unknown pinned
   * version throws rather than falling back to the active version: silently
   * evaluating a different policy would make an audit trail — the whole point
   * of pinning — actively misleading.
   */
  private async loadPolicy(version: string | undefined): Promise<VersionedPolicy> {
    if (version === undefined) {
      return this.policyStore.getActivePolicy();
    }
    const pinned = await this.policyStore.getPolicyVersion(version);
    if (pinned === null) {
      throw new PolicyNotFoundError(version);
    }
    return pinned;
  }

  private emit(stage: string, detail?: string): void {
    if (detail === undefined) {
      this.observer?.({ stage });
    } else {
      this.observer?.({ stage, detail });
    }
  }

  private async evaluateArtifact(
    policy: VersionedPolicy,
    subject: Identifier,
    action: string,
    resource: Identifier,
    context: AuthorizationContext,
  ): Promise<import("./finalize.js").ArtifactResult> {
    if (!isCompiledArtifactShape(policy.artifact)) {
      // Defective loaded artifact → fail closed with an explained DENY (ADR-0010).
      return {
        value: "unknown",
        error: true,
        node: {
          kind: "error",
          description: `defective policy artifact (version ${policy.version})`,
          outcome: "unknown",
        },
      };
    }
    const definitions = policy.artifact.definitions;
    const definition: PolicyDefinition | undefined = definitions[resource.type];
    if (definition === undefined) {
      return {
        value: "false",
        error: false,
        node: {
          kind: "permission",
          description: `no policy for resource type "${resource.type}"`,
          outcome: "not_matched",
        },
      };
    }
    const permission = permissionName(action, resource.type);
    const expr: PolicyExpression | undefined = definition.permissions[permission];
    if (expr === undefined) {
      return {
        value: "false",
        error: false,
        node: {
          kind: "permission",
          description: `no policy for action "${action}"`,
          outcome: "not_matched",
        },
      };
    }

    const state: EvalState = {
      subject,
      context,
      definitions,
      store: this.relationshipStore,
      limits: this.limits,
      visited: new Set<string>(),
      visitedCount: 0,
    };
    const { value, node } = await this.evaluate(expr, resource, definition, state, 0);
    this.emit("decision", value);
    return { value, node, error: false };
  }
}
