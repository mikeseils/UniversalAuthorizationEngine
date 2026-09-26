import { describe, expect, it } from "vitest";
import {
  PolicyDefinition,
  StructuredPolicy,
  allOf,
  anyOf,
  contextEquals,
  indirectRef,
  notExpr,
  relationRef,
} from "../packages/policy/src/index.js";
import { DEFAULT_LIMITS, Evaluator } from "../packages/evaluator/src/index.js";
import { ACME_POLICY, acmeSetup, check, publishAndActivate } from "./helpers.js";

async function evaluatorFor(
  policy: StructuredPolicy = ACME_POLICY,
  limits?: Partial<typeof DEFAULT_LIMITS>,
) {
  const { policyStore, relationships, evaluator } = acmeSetup({ source: policy });
  // approver edge for the context-condition test policy (harmless for Acme)
  relationships.add({ subject: "user:alice", relation: "approver", resource: "invoice:1" });
  await publishAndActivate(policyStore, { source: policy });
  const configured = limits
    ? new Evaluator({
        policyStore,
        relationshipStore: relationships.asRelationshipStore(),
        limits,
      })
    : evaluator;
  return { evaluator: configured, policyStore, relationships };
}

describe("determinism and purity", () => {
  it("same inputs produce identical decisions AND identical explanations", async () => {
    const { evaluator } = await evaluatorFor();
    const opts = { explanation: "standard" as const };
    const a = await check(evaluator, "user:alice", "document.read", "document:a");
    const b = await check(evaluator, "user:alice", "document.read", "document:a");
    expect(a).toEqual(b);
    const fullA = await evaluator.check(
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      opts,
    );
    const fullB = await evaluator.check(
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      opts,
    );
    expect(fullA).toEqual(fullB);
  });
});

describe("three-valued connective semantics (ADR-0010)", () => {
  const policy: StructuredPolicy = {
    definitions: {
      invoice: {
        relations: { approver: { subjectTypes: ["user"] } },
        contextSchema: { mfa: "boolean" },
        permissions: {
          approve: allOf(relationRef("approver"), contextEquals("mfa", true)),
          escalate: allOf(relationRef("approver"), notExpr(contextEquals("mfa", true))),
        },
      },
    },
  };

  it("missing context key → condition unknown → DENY", async () => {
    const { evaluator } = await evaluatorFor(policy);
    const decision = await check(evaluator, "user:alice", "invoice.approve", "invoice:1");
    expect(decision.allowed).toBe(false);
  });

  it("matched context condition completes the and", async () => {
    const { evaluator } = await evaluatorFor(policy);
    const decision = await evaluator.check({
      subject: "user:alice",
      action: "invoice.approve",
      resource: "invoice:1",
      context: { mfa: true },
    });
    expect(decision.allowed).toBe(true);
  });

  it("`not unknown` stays unknown → negation cannot weaponize missing data", async () => {
    const { evaluator } = await evaluatorFor(policy);
    const decision = await evaluator.check({
      subject: "user:alice",
      action: "invoice.escalate",
      resource: "invoice:1",
    });
    expect(decision.allowed).toBe(false);
  });

  it("present-but-false context satisfies `not` under an affirmative guard", async () => {
    const { evaluator } = await evaluatorFor(policy);
    const decision = await evaluator.check({
      subject: "user:alice",
      action: "invoice.escalate",
      resource: "invoice:1",
      context: { mfa: false },
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("bounded evaluation", () => {
  function chainPolicy(depth: number): StructuredPolicy {
    const definitions: Record<string, PolicyDefinition> = {};
    for (let i = 0; i < depth; i++) {
      definitions[`level${String(i)}`] = {
        relations: {},
        permissions: { read: anyOf(indirectRef("contains", "read", true)) },
      };
    }
    return { definitions };
  }

  it("deep chains beyond maxTraversalDepth yield explained unknown → DENY", async () => {
    const depth = 15;
    const { evaluator, relationships } = await evaluatorFor(chainPolicy(depth), {
      maxTraversalDepth: 5,
    });
    for (let i = 1; i < depth; i++) {
      relationships.add({
        subject: `level${String(i - 1)}:doc`,
        relation: "contains",
        resource: `level${String(i)}:doc`,
      });
    }
    const decision = await check(evaluator, "user:alice", "level14.read", "level14:doc");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("policy_deny");
    const explained = await evaluator.check(
      { subject: "user:alice", action: "level14.read", resource: "level14:doc" },
      { explanation: "debug" },
    );
    expect(JSON.stringify(explained.explanation)).toMatch(/depth limit/);
  });

  it("cyclic graphs terminate and never grant", async () => {
    const { evaluator, relationships } = await evaluatorFor(
      {
        definitions: {
          node: {
            relations: { owner: { subjectTypes: ["user"] } },
            permissions: {
              read: anyOf(relationRef("owner"), indirectRef("contains", "read", true)),
            },
          },
        },
      },
      { maxTraversalDepth: 50 },
    );
    relationships.add({ subject: "node:a", relation: "contains", resource: "node:b" });
    relationships.add({ subject: "node:b", relation: "contains", resource: "node:a" });
    const decision = await check(evaluator, "user:alice", "node.read", "node:a");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("policy_deny");
  });

  it("self-referencing resources do not hang", async () => {
    const { evaluator, relationships } = await evaluatorFor({
      definitions: {
        node: {
          relations: { owner: { subjectTypes: ["user"] } },
          permissions: { read: anyOf(indirectRef("contains", "read", false)) },
        },
      },
    });
    relationships.add({ subject: "node:a", relation: "contains", resource: "node:a" });
    const decision = await check(evaluator, "user:alice", "node.read", "node:a");
    expect(decision.allowed).toBe(false);
  });

  it("DEFAULT_LIMITS constants are sane", () => {
    expect(DEFAULT_LIMITS.maxTraversalDepth).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxVisitedNodes).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxBatchSize).toBeGreaterThan(0);
  });
});

describe("explicit denies for unknown resource types and actions", () => {
  it("denies unknown resource type", async () => {
    const { evaluator } = await evaluatorFor();
    const decision = await check(evaluator, "user:alice", "widget.read", "widget:1");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("policy_deny");
  });

  it("denies actions without a policy", async () => {
    const { evaluator } = await evaluatorFor();
    const decision = await check(evaluator, "user:alice", "document.frobnicate", "document:a");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("policy_deny");
  });
});
