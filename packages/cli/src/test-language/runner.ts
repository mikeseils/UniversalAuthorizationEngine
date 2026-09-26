import { AuthorizationContext, AuthorizationDecision, Relationship, PolicyStore } from "@uae/core";
import { Evaluator, InMemoryRelationshipStore } from "@uae/evaluator";
import { TestBlock, TestTarget } from "./parser.js";

/**
 * Test execution (ADR-0014).
 *
 * - Each test gets its **own** relationship store: baseline data plus that
 *   test's `given` tuples. No test can influence another, and execution order
 *   cannot change results.
 * - Decisions are evaluated at `standard` explanation level so a failing
 *   assertion can show *why* the engine decided what it did. Levels never
 *   change the decision (ADR-0011), and explanations come from the same
 *   evaluation pass — nothing is recomputed.
 * - `deny` means `allowed === false` **and** `reason === "policy_deny"`: an
 *   `error` outcome can never satisfy a negative assertion.
 */

export interface AssertionResult {
  readonly testName: string;
  /** Canonical source form, e.g. `check(user:bob, project.delete, project:alpha) == deny`. */
  readonly source: string;
  readonly target: TestTarget;
  readonly passed: boolean;
  readonly file: string;
  readonly line: number;
  readonly decision: AuthorizationDecision;
}

export interface RunTestDependencies {
  readonly policyStore: PolicyStore;
  readonly baseline: readonly Relationship[];
  readonly file: string;
}

export function assertionHolds(decision: AuthorizationDecision, target: TestTarget): boolean {
  switch (target) {
    case "allow":
      return decision.allowed;
    case "deny":
      // An `error` outcome can never satisfy `deny` (ADR-0014): a broken policy
      // must not look like a passing negative test.
      return !decision.allowed && decision.reason === "policy_deny";
    case "error":
      return !decision.allowed && decision.reason === "error";
  }
}

export async function runTestBlock(
  block: TestBlock,
  deps: RunTestDependencies,
): Promise<readonly AssertionResult[]> {
  const relationships = new InMemoryRelationshipStore();
  relationships.addAll(deps.baseline);
  for (const tuple of block.given) {
    relationships.add({
      subject: tuple.subject,
      relation: tuple.relation,
      resource: tuple.resource,
    });
  }

  const evaluator = new Evaluator({
    policyStore: deps.policyStore,
    relationshipStore: relationships.asRelationshipStore(),
  });

  const context: AuthorizationContext = block.context;
  const results: AssertionResult[] = [];
  for (const assertion of block.assertions) {
    const decision = await evaluator.check(
      {
        subject: assertion.subject,
        action: assertion.action,
        resource: assertion.resource,
        ...(Object.keys(context).length > 0 ? { context } : {}),
      },
      { explanation: "standard" },
    );
    results.push({
      testName: block.name,
      source: assertion.source,
      target: assertion.target,
      passed: assertionHolds(decision, assertion.target),
      file: deps.file,
      line: assertion.location.line,
      decision,
    });
  }
  return results;
}
