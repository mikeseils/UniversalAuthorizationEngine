/**
 * Explanation model (docs/design/explanations.md). DRAFT types.
 *
 * Explanations are generated from the same evaluation pass as the decision —
 * never a separate approximate engine — and are disclosed according to
 * detail levels, because explanation content can leak sensitive policy
 * information to unauthorized callers.
 */

/** Disclosure level for explanation content. */
export type ExplanationLevel = "none" | "minimal" | "standard" | "debug";

/** What kind of evaluation step produced this node. */
export type ExplanationNodeKind = "permission" | "relation" | "condition" | "error" | "bound";

/** Outcome of the evaluated step. `unknown` preserves default-deny visibility. */
export type ExplanationOutcome = "matched" | "not_matched" | "unknown" | "skipped";

export interface ExplanationNode {
  readonly kind: ExplanationNodeKind;
  readonly description: string;
  readonly outcome: ExplanationOutcome;
  readonly children?: readonly ExplanationNode[];
}

/**
 * The result of an authorization evaluation (docs/design/evaluation-model.md).
 * DRAFT type.
 *
 * Binding rules:
 * - `allowed` is `false` for every DENY, including all error paths
 *   (unknown → deny, ADR-0006).
 * - `policyVersion`, when present, cites the exact immutable policy artifact
 *   that produced the decision (reproducibility/rollback/audit).
 * - `reason` classifies why the decision was made; `error` decisions are
 *   still DENY.
 */
export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: DecisionReason;
  readonly explanation?: ExplanationNode;
  readonly policyVersion?: string;
}

/** Classification of a decision outcome. */
export type DecisionReason =
  /** A policy branch matched. */
  | "policy_allow"
  /** No branch matched (the normal, explained deny). */
  | "policy_deny"
  /** Deny forced by explicit policy logic (future deny-rules). */
  | "policy_deny_rule"
  /** Evaluation could not complete; fail-closed (ADR-0006). */
  | "error";
