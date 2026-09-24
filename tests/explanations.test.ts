import { describe, expect, it } from "vitest";
import { acmeSetup, check, publishAndActivate } from "./helpers.js";
import { AuthorizationDecision } from "../packages/core/src/index.js";

const setup = async () => {
  const { evaluator, policyStore } = acmeSetup();
  await publishAndActivate(policyStore);
  return evaluator;
};

describe("explanations (ADR-0011)", () => {
  it("default level is none — no leakage by default", async () => {
    const evaluator = await setup();
    const decision = await check(evaluator, "user:bob", "document.read", "document:a");
    expect(decision.explanation).toBeUndefined();
  });

  it("minimal level: root node only", async () => {
    const evaluator = await setup();
    const decision = await evaluator.check(
      { subject: "user:bob", action: "document.read", resource: "document:a" },
      { explanation: "minimal" },
    );
    expect(decision.explanation).toEqual({
      kind: "permission",
      description: "document.read on document:a",
      outcome: "matched",
    });
  });

  it("standard level: full matched path, skipped branches pruned", async () => {
    const evaluator = await setup();
    const decision = await evaluator.check(
      { subject: "user:bob", action: "document.read", resource: "document:a" },
      { explanation: "standard" },
    );
    const json = JSON.stringify(decision.explanation);
    // Shows the traversal that matched Bob through the project
    expect(json).toContain("user:bob --viewer--> project:alpha");
    expect(json).toContain("project:alpha --contains--> document:a");
    // Prunes branches that were structurally skipped
    const tree = decision.explanation as Required<
      Pick<NonNullable<typeof decision.explanation>, "children">
    >;
    expect(JSON.stringify(tree)).not.toContain('"skipped"');
  });

  it("debug level includes everything", async () => {
    const evaluator = await setup();
    const decision = await evaluator.check(
      { subject: "user:bob", action: "document.read", resource: "document:a" },
      { explanation: "debug" },
    );
    expect(decision.explanation?.children?.length ?? 0).toBeGreaterThan(0);
  });

  it("level can never change the decision", async () => {
    const evaluator = await setup();
    const bare = await check(evaluator, "user:bob", "document.delete", "document:a");
    const levels: AuthorizationDecision[] = [];
    for (const level of ["none", "minimal", "standard", "debug"] as const) {
      levels.push(
        await evaluator.check(
          { subject: "user:bob", action: "document.delete", resource: "document:a" },
          { explanation: level },
        ),
      );
    }
    for (const d of [bare, ...levels]) {
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("policy_deny");
    }
  });

  it("explanations are deterministic", async () => {
    const evaluator = await setup();
    const opts = { explanation: "debug" as const };
    const req = { subject: "user:alice", action: "document.delete", resource: "document:a" };
    expect(await evaluator.check(req, opts)).toEqual(await evaluator.check(req, opts));
  });
});
