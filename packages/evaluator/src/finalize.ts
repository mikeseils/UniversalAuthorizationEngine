import { AuthorizationDecision, ExplanationLevel, ExplanationNode, Identifier } from "@uae/core";

export interface ArtifactResult {
  readonly value: TriVal;
  readonly node: ExplanationNode;
  readonly error: boolean;
}
type TriVal = "true" | "false" | "unknown";

export function finalize(
  result: ArtifactResult,
  policyVersion: string,
  action: string,
  resource: Identifier,
  level: ExplanationLevel,
): AuthorizationDecision {
  const allowed = result.value === "true";
  const reason = allowed ? "policy_allow" : result.error ? "error" : "policy_deny";
  const root: ExplanationNode = {
    kind: "permission",
    description: `${action} on ${resource.type}:${resource.id}`,
    outcome: allowed ? "matched" : result.error ? "unknown" : "not_matched",
    children: [result.node],
  };
  const decision: AuthorizationDecision = {
    allowed,
    reason,
    policyVersion,
  };
  const explanation = pruneExplanation(root, level);
  if (explanation !== undefined) {
    return { ...decision, explanation };
  }
  return decision;
}

/** Pruning happens after full evaluation — levels never change the decision (ADR-0011). */
export function pruneExplanation(
  root: ExplanationNode,
  level: ExplanationLevel,
): ExplanationNode | undefined {
  switch (level) {
    case "none":
      return undefined;
    case "minimal":
      return { kind: root.kind, description: root.description, outcome: root.outcome };
    case "standard":
      return pruneSkipped(root);
    case "debug":
      return root;
  }
}

function pruneSkipped(node: ExplanationNode): ExplanationNode {
  const children = node.children?.filter((child) => child.outcome !== "skipped").map(pruneSkipped);
  return children === undefined
    ? { kind: node.kind, description: node.description, outcome: node.outcome }
    : { kind: node.kind, description: node.description, outcome: node.outcome, children };
}
