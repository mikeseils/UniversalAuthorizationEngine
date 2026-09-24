import { Identifier } from "@uae/core";
import { IndirectRef } from "@uae/policy";
import {
  EvaluatorFn,
  EvalResult,
  EvalState,
  evalAllOf,
  evalAnyOf,
  evalContext,
  evalRelation,
  boundNode,
  outcomeFor,
} from "./eval-ops.js";

/**
 * Bounded, cycle-safe ReBAC traversal (ADR-0010):
 * "subject has `permission` on X, where X is linked to `resource` by `relation`".
 * No candidates → `false`; bound exceeded or cycle revisit → `unknown`.
 */
export async function evalIndirect(
  expr: IndirectRef,
  resource: Identifier,
  state: EvalState,
  depth: number,
  evaluate: EvaluatorFn,
): Promise<EvalResult> {
  if (depth + 1 > state.limits.maxTraversalDepth) {
    return boundNode(`traversal depth limit (${String(state.limits.maxTraversalDepth)}) reached`);
  }
  const visitKey = `${expr.permission}|${resource.type}:${resource.id}`;
  if (state.visited.has(visitKey)) {
    return boundNode(`cycle detected at ${resource.type}:${resource.id} via "${expr.relation}"`);
  }
  state.visited.add(visitKey);
  state.visitedCount += 1;
  if (state.visitedCount > state.limits.maxVisitedNodes) {
    return boundNode(`visited-node limit (${String(state.limits.maxVisitedNodes)}) exceeded`);
  }

  const found = expr.reverse
    ? await state.store.getRelationships({ resource, relation: expr.relation })
    : await state.store.getRelationships({ subject: resource, relation: expr.relation });

  const children = [];
  let sawUnknown = false;
  let sawTrue = false;
  for (const edge of found) {
    const candidate: Identifier = expr.reverse ? edge.subject : edge.resource;
    const candidateDef = state.definitions[candidate.type];
    const candidateExpr = candidateDef?.permissions[expr.permission];
    const description = expr.reverse
      ? `${candidate.type}:${candidate.id} --${expr.relation}--> ${resource.type}:${resource.id}`
      : `${resource.type}:${resource.id} --${expr.relation}--> ${candidate.type}:${candidate.id}`;
    if (candidateDef === undefined || candidateExpr === undefined) {
      children.push({ kind: "relation" as const, description, outcome: "skipped" as const });
      continue;
    }
    const { value, node } = await evaluate(
      candidateExpr,
      candidate,
      candidateDef,
      state,
      depth + 1,
    );
    children.push({
      kind: "relation" as const,
      description,
      outcome: outcomeFor(value),
      children: [node],
    });
    if (value === "true") sawTrue = true;
    if (value === "unknown") sawUnknown = true;
  }

  const value: EvalResult["value"] = sawTrue ? "true" : sawUnknown ? "unknown" : "false";
  return {
    value,
    node: {
      kind: "relation",
      description: `traverse "${expr.relation}"${expr.reverse ? " (reverse)" : ""} for "${expr.permission}"`,
      outcome: outcomeFor(value),
      children,
    },
  };
}

/** Dispatcher: evaluates one expression node against the current resource. */
export function makeEvaluatorFn(): EvaluatorFn {
  const evaluate: EvaluatorFn = async (expr, resource, definition, state, depth) => {
    switch (expr.kind) {
      case "relation":
        return evalRelation(expr.relation, resource, state);
      case "indirect":
        return evalIndirect(expr, resource, state, depth, evaluate);
      case "contextEquals":
        return evalContext(expr, state);
      case "or":
        return evalAnyOf(expr.operands, resource, definition, state, depth, evaluate);
      case "and":
        return evalAllOf(expr.operands, resource, definition, state, depth, evaluate);
      case "not": {
        const inner = await evaluate(expr.operand, resource, definition, state, depth);
        const value: EvalResult["value"] =
          inner.value === "unknown" ? "unknown" : inner.value === "true" ? "false" : "true";
        return { value, node: inner.node };
      }
    }
  };
  return evaluate;
}
