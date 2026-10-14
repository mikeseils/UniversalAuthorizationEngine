/**
 * @uae/evaluator — deterministic, side-effect-free, fail-closed authorization
 * evaluation with bounded ReBAC traversal and same-pass explanations.
 * DRAFT shapes — see docs/architecture/api-boundaries.md.
 */
export { Evaluator } from "./evaluator.js";
export { DecisionCache, decisionCacheKey } from "./decision-cache.js";
export type {
  DecisionCacheKeyInput,
  DecisionCacheOptions,
  DecisionCacheStats,
} from "./decision-cache.js";
export { PolicyCache } from "./policy-cache.js";
export type { PolicyCacheOptions, PolicyCacheStats } from "./policy-cache.js";
export { InMemoryRelationshipStore } from "./in-memory-relationship-store.js";
export { DEFAULT_LIMITS } from "./limits.js";
export type { EvaluationLimits, EvaluationObserver } from "./limits.js";
export type { CheckOptions, EvaluatorDependencies } from "./types.js";
export { permissionName } from "./permission-name.js";
export { InstrumentedRelationshipStore, percentiles, queryShape } from "./store-metrics.js";
export type {
  MonotonicClock,
  RelationshipQueryShape,
  RelationshipStoreReport,
} from "./store-metrics.js";
