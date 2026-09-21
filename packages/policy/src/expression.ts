/**
 * Boolean/traversal expression trees over relations and context
 * (docs/adr/0009-structured-policy.md). DRAFT shapes — the Phase 3 language
 * decision will replace the *source* syntax; these carry over as compiled
 * semantics.
 */

/** Allowed context attribute types (Context is data, never code). */
export type ContextAttributeType = "string" | "number" | "boolean";

/** Literal values permitted inside a `contextEquals` condition. */
export type ContextLiteral = string | number | boolean;

/** Subject has a direct `(subject, relation, resource)` edge. */
export interface RelationRef {
  readonly kind: "relation";
  readonly relation: string;
}

/**
 * ReBAC traversal (bounded, cycle-safe): "subject has `permission` on resource
 * X, where X is linked to the current resource by `relation`".
 * - `reverse: false` → follow `resource --relation--> X`
 * - `reverse: true`  → follow `X --relation--> resource`
 */
export interface IndirectRef {
  readonly kind: "indirect";
  readonly relation: string;
  readonly reverse: boolean;
  readonly permission: string;
}

/** Equality condition on a declared context attribute. */
export interface ContextEquals {
  readonly kind: "contextEquals";
  readonly key: string;
  readonly value: ContextLiteral;
}

export interface AllOf {
  readonly kind: "and";
  readonly operands: readonly PolicyExpression[];
}

export interface AnyOf {
  readonly kind: "or";
  readonly operands: readonly PolicyExpression[];
}

export interface NotExpr {
  readonly kind: "not";
  readonly operand: PolicyExpression;
}

export type PolicyExpression = RelationRef | IndirectRef | ContextEquals | AllOf | AnyOf | NotExpr;

/** Builders — the Phase 2 authoring surface (source syntax arrives in Phase 3). */
export const relationRef = (relation: string): RelationRef => ({
  kind: "relation",
  relation,
});

export const indirectRef = (
  relation: string,
  permission: string,
  reverse: boolean,
): IndirectRef => ({ kind: "indirect", relation, permission, reverse });

export const contextEquals = (key: string, value: ContextLiteral): ContextEquals => ({
  kind: "contextEquals",
  key,
  value,
});

export const allOf = (...operands: PolicyExpression[]): AllOf => ({
  kind: "and",
  operands,
});

export const anyOf = (...operands: PolicyExpression[]): AnyOf => ({
  kind: "or",
  operands,
});

export const notExpr = (operand: PolicyExpression): NotExpr => ({
  kind: "not",
  operand,
});
