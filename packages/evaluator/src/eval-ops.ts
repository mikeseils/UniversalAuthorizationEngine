import {
  AuthorizationContext,
  ExplanationNode,
  ExplanationOutcome,
  Identifier,
  Relationship,
  RelationshipStore,
} from "@uae/core";
import { PolicyDefinition, PolicyExpression } from "@uae/policy";
import { EvaluationLimits } from "./limits.js";

export type TriValue = "true" | "false" | "unknown";

export interface EvalResult {
  value: TriValue;
  node: ExplanationNode;
}

export interface EvalState {
  readonly subject: Identifier;
  readonly context: AuthorizationContext;
  readonly definitions: Readonly<Record<string, PolicyDefinition>>;
  readonly store: RelationshipStore;
  readonly limits: EvaluationLimits;
  /** (permission|resource) keys visited by `indirect` traversal — cycle guard. */
  readonly visited: Set<string>;
  visitedCount: number;
}

export function outcomeFor(value: TriValue): ExplanationOutcome {
  return value === "true" ? "matched" : value === "unknown" ? "unknown" : "not_matched";
}

export function groupNode(
  kind: "and" | "or",
  value: TriValue,
  children: ExplanationNode[],
): EvalResult {
  return {
    value,
    node: {
      kind: "permission",
      description: kind,
      outcome: outcomeFor(value),
      children,
    },
  };
}

export function boundNode(description: string): EvalResult {
  return { value: "unknown", node: { kind: "bound", description, outcome: "unknown" } };
}

/** Direct edge check: a missing edge is `false`, not `unknown` (ADR-0010). */
export async function evalRelation(
  relation: string,
  resource: Identifier,
  state: EvalState,
): Promise<EvalResult> {
  const found = await state.store.getRelationships({
    subject: state.subject,
    relation,
    resource,
  });
  const matched = found.length > 0;
  return {
    value: matched ? "true" : "false",
    node: {
      kind: "relation",
      description: `${state.subject.type}:${state.subject.id} --${relation}--> ${resource.type}:${resource.id}`,
      outcome: outcomeFor(matched ? "true" : "false"),
    },
  };
}

/**
 * Context condition. Missing or type-mismatched data is `unknown` — so
 * `not` cannot weaponize absent attributes (ADR-0010).
 */
export function evalContext(
  expr: { readonly key: string; readonly value: string | number | boolean },
  state: EvalState,
): EvalResult {
  const base: ExplanationNode = {
    kind: "condition",
    description: `context.${expr.key} == ${JSON.stringify(expr.value)}`,
    outcome: "not_matched",
  };
  if (!(expr.key in state.context)) {
    return { value: "unknown", node: { ...base, outcome: "unknown" } };
  }
  const actual = (state.context as Record<string, unknown>)[expr.key];
  if (typeof actual !== typeof expr.value) {
    return { value: "unknown", node: { ...base, outcome: "unknown" } };
  }
  const matched = actual === expr.value;
  return {
    value: matched ? "true" : "false",
    node: { ...base, outcome: matched ? "matched" : "not_matched" },
  };
}

export async function evalAnyOf(
  operands: readonly PolicyExpression[],
  resource: Identifier,
  definition: PolicyDefinition,
  state: EvalState,
  depth: number,
  evaluate: EvaluatorFn,
): Promise<EvalResult> {
  let sawUnknown = false;
  const children: ExplanationNode[] = [];
  for (const op of operands) {
    const { value, node } = await evaluate(op, resource, definition, state, depth);
    children.push(node);
    if (value === "true") return groupNode("or", "true", children);
    if (value === "unknown") sawUnknown = true;
  }
  return groupNode("or", sawUnknown ? "unknown" : "false", children);
}

export async function evalAllOf(
  operands: readonly PolicyExpression[],
  resource: Identifier,
  definition: PolicyDefinition,
  state: EvalState,
  depth: number,
  evaluate: EvaluatorFn,
): Promise<EvalResult> {
  let sawUnknown = false;
  const children: ExplanationNode[] = [];
  for (const op of operands) {
    const { value, node } = await evaluate(op, resource, definition, state, depth);
    children.push(node);
    if (value === "false") return groupNode("and", "false", children);
    if (value === "unknown") sawUnknown = true;
  }
  return groupNode("and", sawUnknown ? "unknown" : "true", children);
}

export type EvaluatorFn = (
  expr: PolicyExpression,
  resource: Identifier,
  definition: PolicyDefinition,
  state: EvalState,
  depth: number,
) => Promise<EvalResult>;

export type { Relationship };
