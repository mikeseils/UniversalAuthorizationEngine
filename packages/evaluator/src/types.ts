import type { RelationshipStore } from "@uae/core";
import type { DecisionCache } from "./decision-cache.js";
import type { EvaluationLimits, EvaluationObserver } from "./limits.js";

export interface EvaluatorDependencies {
  readonly policyStore: import("@uae/core").PolicyStore;
  readonly relationshipStore: RelationshipStore;
  readonly limits?: Partial<EvaluationLimits>;
  readonly observer?: EvaluationObserver;
  /**
   * Opt-in version-keyed decision cache (ADR-0021). Default: no cache, so the
   * strong-consistency path (`docs/architecture/caching.md` rule 4) remains
   * the default. When provided, `relationshipStore` must expose
   * `getRelationshipVersion()` (ADR-0018 S11) — otherwise construction throws
   * rather than silently degrading to an unkeyed cache.
   */
  readonly decisionCache?: DecisionCache;
}

export interface CheckOptions {
  /** Explanation detail level; default `"none"` (no leakage by default). */
  readonly explanation?: import("@uae/core").ExplanationLevel;
  /**
   * Evaluate against this exact policy version instead of the active one
   * (ADR-0019). When omitted, the active version is used — the default is
   * unchanged. An unknown version is a typed error, never a silent fallback
   * to the active version: reproducing a decision against the wrong policy
   * would be worse than failing.
   */
  readonly policyVersion?: string;
}
