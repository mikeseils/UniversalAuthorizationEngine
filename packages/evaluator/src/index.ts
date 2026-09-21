/**
 * @uae/evaluator — deterministic, side-effect-free, fail-closed authorization
 * evaluation with bounded ReBAC traversal and same-pass explanations.
 * DRAFT shapes — see docs/architecture/api-boundaries.md.
 */
export { Evaluator } from "./evaluator.js";
export { InMemoryRelationshipStore } from "./in-memory-relationship-store.js";
export { DEFAULT_LIMITS } from "./limits.js";
export type { EvaluationLimits, EvaluationObserver } from "./limits.js";
export type { CheckOptions, EvaluatorDependencies } from "./types.js";
export { permissionName } from "./permission-name.js";
