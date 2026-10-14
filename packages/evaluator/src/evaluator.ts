import {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationRequest,
  Identifier,
  PolicyNotFoundError,
  PolicyStore,
  RelationshipQuery,
  ValidationError,
  VersionedPolicy,
  VersionedRelationshipStore,
  coerceIdentifier,
  parseAction,
} from "@uae/core";
import { isCompiledArtifactShape, PolicyDefinition, PolicyExpression } from "@uae/policy";
import { DecisionCache, decisionCacheKey } from "./decision-cache.js";
import { PolicyCache } from "./policy-cache.js";
import { RelationshipCache } from "./relationship-cache.js";
import { finalize } from "./finalize.js";
import { EvalState, makeEvaluatorFn } from "./internal-eval.js";
import {
  DEFAULT_LIMITS,
  EvaluationLimits,
  EvaluationObserver,
  makeStageClock,
  type StageClock,
} from "./limits.js";
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
  private readonly decisionCache?: DecisionCache;
  private readonly policyCache?: PolicyCache;
  /**
   * The relationship query cache in use, when configured (ADR-0023). The
   * evaluator constructs it around the store it was given — exposed here so
   * callers can read stats and reset it.
   */
  public readonly relationshipCache?: RelationshipCache;

  constructor(deps: EvaluatorDependencies) {
    this.policyStore = deps.policyStore;
    this.relationshipStore = deps.relationshipStore;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    if (deps.observer !== undefined) {
      this.observer = deps.observer;
    }
    if (deps.decisionCache !== undefined) {
      // A cache without a version source cannot be keyed by state, and an
      // unkeyed decision cache is exactly what caching.md rule 1 forbids —
      // failing here beats serving TTL-stale decisions later (ADR-0021 §6).
      const versioned = this.relationshipStore as Partial<VersionedRelationshipStore>;
      if (typeof versioned.getRelationshipVersion !== "function") {
        throw new ValidationError(
          "decisionCache",
          "relationship store does not expose getRelationshipVersion(); version-keyed caching requires the ADR-0018 S11 version surface",
        );
      }
      this.decisionCache = deps.decisionCache;
    }
    if (deps.policyCache !== undefined) {
      this.policyCache = deps.policyCache;
    }
    if (deps.relationshipCache !== undefined) {
      // Same requirement as the decision cache: query caching keys entries by
      // the state version, so a store that cannot report one cannot be cached
      // against (ADR-0023, ADR-0018 S11).
      const versioned = this.relationshipStore as Partial<VersionedRelationshipStore>;
      if (typeof versioned.getRelationshipVersion !== "function") {
        throw new ValidationError(
          "relationshipCache",
          "relationship store does not expose getRelationshipVersion(); query caching requires the ADR-0018 S11 version surface",
        );
      }
      this.relationshipCache = new RelationshipCache(
        this.relationshipStore,
        deps.relationshipCache,
      );
    }
  }

  /**
   * Evaluate one request. Subjects/resources may be given as `type:id` strings
   * or parsed identifiers. Malformed requests throw at the boundary
   * (`ValidationError`); infrastructure failures propagate typed errors; every
   * evaluated outcome is fail-closed (ADR-0010).
   *
   * With a decision cache configured, the relationship-state version is read
   * here — once, before evaluation (ADR-0021 §2).
   */
  async check(
    request: AuthorizationRequest,
    options?: CheckOptions,
  ): Promise<AuthorizationDecision> {
    const relationshipVersion =
      this.decisionCache === undefined && this.relationshipCache === undefined
        ? undefined
        : await this.relationshipVersion();
    return this.runCheck(request, options, relationshipVersion);
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
   *
   * With a decision cache configured, the relationship version is read **once
   * for the whole batch**: every item keys to the same token, read at batch
   * start. The safety property is the per-item one — an entry keyed `v` was
   * computed from state ≥ `v`, and a moved version makes it unreachable -
   * with N-1 fewer reads. An empty batch reads nothing.
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
    const relationshipVersion =
      requests.length > 0 &&
      (this.decisionCache !== undefined || this.relationshipCache !== undefined)
        ? await this.relationshipVersion()
        : undefined;
    const decisions: AuthorizationDecision[] = [];
    for (const request of requests) {
      decisions.push(await this.runCheck(request, options, relationshipVersion));
    }
    return decisions;
  }

  /**
   * One check against a relationship version the caller resolved.
   *
   * `check()` resolves the version per item; `checkBatch()` resolves it once
   * for the whole batch and passes the same token down. Either way the read
   * happens before evaluation, so an entry keyed `v` is computed from state
   * >= `v` (ADR-0021 §2).
   */
  private async runCheck(
    request: AuthorizationRequest,
    options: CheckOptions | undefined,
    relationshipVersion: string | undefined,
  ): Promise<AuthorizationDecision> {
    const subject = coerceIdentifier(request.subject, "subject");
    const action = parseAction(request.action);
    const resource = coerceIdentifier(request.resource, "resource");
    const context: AuthorizationContext = request.context ?? {};
    const clock = this.observer === undefined ? undefined : makeStageClock(this.observer);
    clock?.emit("normalize", `${action} on ${resource.type}:${resource.id}`);

    const policy = await this.loadPolicy(options?.policyVersion);
    clock?.emit("policy:loaded", policy.version);

    const level = options?.explanation ?? "none";
    const cache = this.decisionCache;
    const cacheKey =
      cache !== undefined && relationshipVersion !== undefined
        ? decisionCacheKey({
            subject,
            action,
            resource,
            policyVersion: policy.version,
            relationshipVersion,
            explanationLevel: level,
            context,
          })
        : undefined;
    if (cacheKey !== undefined && cache !== undefined) {
      const hit = cache.get(cacheKey);
      if (hit !== undefined) {
        clock?.emit("cache:hit");
        return hit;
      }
      clock?.emit("cache:miss");
    }

    const result = await this.evaluateArtifact(
      policy,
      subject,
      action,
      resource,
      context,
      clock,
      relationshipVersion,
    );
    const decision = finalize(result, policy.version, action, resource, level);
    if (cacheKey !== undefined && cache !== undefined) {
      // `set` refuses `reason: "error"` decisions (ADR-0021 §3); everything
      // else — including denials — is safe to key by state version.
      cache.set(cacheKey, decision);
    }
    return decision;
  }

  /**
   * Current relationship-state version (ADR-0018 S11). Only reachable when a
   * cache is configured — the constructor already guaranteed the method exists
   * in that case.
   */
  private relationshipVersion(): Promise<string> {
    return (this.relationshipStore as VersionedRelationshipStore).getRelationshipVersion();
  }

  /**
   * Resolve the policy artifact to evaluate (ADR-0019, ADR-0022).
   *
   * Pinning is opt-in and the default path is unchanged. An unknown pinned
   * version throws rather than falling back to the active version: silently
   * evaluating a different policy would make an audit trail — the whole point
   * of pinning — actively misleading.
   *
   * With a policy cache configured, the artifact is served from it when the
   * version is known (ADR-0022): artifacts are immutable (ADR-0018 S8), so a
   * hit needs no invalidation logic. On the active path that also requires
   * the store's getActiveVersion pointer surface — without it the store's
   * active-policy read is one atomic operation and is used unchanged.
   */
  private async loadPolicy(version: string | undefined): Promise<VersionedPolicy> {
    if (version === undefined) {
      if (
        this.policyCache === undefined ||
        typeof this.policyStore.getActiveVersion !== "function"
      ) {
        return this.policyStore.getActivePolicy();
      }
      const active = await this.policyStore.getActiveVersion();
      if (active === null) {
        // No active policy — delegate to getActivePolicy so the store's own
        // typed error surfaces unchanged (ADR-0018 S9), never a fabricated one.
        return this.policyStore.getActivePolicy();
      }
      return this.loadVersion(active);
    }
    return this.loadVersion(version);
  }

  /**
   * Load one artifact by version, through the policy cache when configured.
   *
   * Keyed by version, never invalidated: a superseded version simply stops
   * being looked up — exactly the discipline the decision cache uses for
   * relationship versions (ADR-0021 §2).
   */
  private async loadVersion(version: string): Promise<VersionedPolicy> {
    if (this.policyCache === undefined) {
      const pinned = await this.policyStore.getPolicyVersion(version);
      if (pinned === null) {
        throw new PolicyNotFoundError(version);
      }
      return pinned;
    }
    const cached = this.policyCache.get(version);
    if (cached !== undefined) {
      return cached;
    }
    const policy = await this.policyStore.getPolicyVersion(version);
    if (policy === null) {
      throw new PolicyNotFoundError(version);
    }
    this.policyCache.set(version, policy);
    return policy;
  }

  private async evaluateArtifact(
    policy: VersionedPolicy,
    subject: Identifier,
    action: string,
    resource: Identifier,
    context: AuthorizationContext,
    clock?: StageClock,
    relationshipVersion?: string,
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
      store: this.storeFor(relationshipVersion),
      limits: this.limits,
      visited: new Set<string>(),
      visitedCount: 0,
    };
    const { value, node } = await this.evaluate(expr, resource, definition, state, 0);
    clock?.emit("decision", value);
    return { value, node, error: false };
  }

  /**
   * The store the evaluation queries through: the raw store, or a per-check
   * view over the relationship cache keyed by this check's state version
   * (ADR-0023). With no cache configured the raw store is used directly.
   */
  private storeFor(version: string | undefined): import("@uae/core").RelationshipStore {
    const cache = this.relationshipCache;
    if (cache === undefined || version === undefined) {
      return this.relationshipStore;
    }
    return {
      getRelationships: (query: RelationshipQuery) => cache.query(query, version),
    };
  }
}
