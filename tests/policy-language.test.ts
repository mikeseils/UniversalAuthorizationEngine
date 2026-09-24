import { describe, expect, it } from "vitest";
import { Evaluator, InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import { InMemoryPolicyStore, PolicyStoreError } from "../packages/policy/src/index.js";
import { AuthorizationDecision } from "../packages/core/src/index.js";
import { ACME_POLICY, APPROVAL_POLICY, acmeSetup, check, readAcmePolicyText } from "./helpers.js";

// (subject, action, resource) whose decision must not depend on the authoring
// surface — the same assertions hold for the text-language twin.
const ACME_CASES: ReadonlyArray<[string, string, string]> = [
  ["user:alice", "organization.manage", "organization:acme"],
  ["user:alice", "organization.read", "organization:acme"],
  ["user:bob", "organization.read", "organization:acme"],
  ["user:bob", "organization.manage", "organization:acme"],
  ["user:alice", "project.read", "project:alpha"],
  ["user:alice", "project.write", "project:alpha"],
  ["user:alice", "project.delete", "project:alpha"],
  ["user:bob", "project.read", "project:alpha"],
  ["user:bob", "project.write", "project:alpha"],
  ["user:bob", "project.delete", "project:alpha"],
  ["user:alice", "document.read", "document:a"],
  ["user:alice", "document.delete", "document:a"],
  ["user:bob", "document.read", "document:a"],
  ["user:bob", "document.delete", "document:a"],
  ["user:carol", "document.read", "document:a"],
  ["user:carol", "project.read", "project:alpha"],
  ["user:carol", "organization.read", "organization:acme"],
  ["user:bob", "document.delete", "document:b"],
];

const DECISION_KEYS = (d: AuthorizationDecision) => ({ allowed: d.allowed, reason: d.reason });

const INVOICE_TEXT = `
definition invoice {
  context mfa: boolean
  relation approver: user
  permission approve = approver and context.mfa == true
}
`;

describe("policy language: canonical Acme text policy", () => {
  it("is valid and publishable", async () => {
    const store = new InMemoryPolicyStore();
    const versioned = await store.publishPolicy({ source: readAcmePolicyText(), format: "text" });
    expect(versioned.version).toBe("1");
    expect(versioned.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(versioned.warnings ?? []).toEqual([]);
  });

  it("produces identical decisions to the programmatic ACME_POLICY", async () => {
    // Programmatic ACME policy on a fresh store/evaluator pair.
    const structured = acmeSetup();
    const v1 = await structured.policyStore.publishPolicy({ source: ACME_POLICY });
    structured.policyStore.setActiveVersion(v1.version);

    // Text ACME policy on a separate fresh pair.
    const { evaluator, policyStore } = acmeSetup();
    const v2 = await policyStore.publishPolicy({ source: readAcmePolicyText(), format: "text" });
    policyStore.setActiveVersion(v2.version);

    for (const [subject, action, resource] of ACME_CASES) {
      const fromStructured = await check(structured.evaluator, subject, action, resource);
      const fromText = await check(evaluator, subject, action, resource);
      expect(DECISION_KEYS(fromText), `${subject} ${action} ${resource} (text)`).toEqual(
        DECISION_KEYS(fromStructured),
      );
    }
  });

  it("honors context conditions exactly like the structured approval policy", async () => {
    // alice is an approver on invoice:1; approval additionally requires mfa == true
    const seed = [{ subject: "user:alice", relation: "approver", resource: "invoice:1" }];
    const freshRelationships = () => {
      const r = new InMemoryRelationshipStore();
      r.addAll(seed);
      return r;
    };

    const textStore = new InMemoryPolicyStore();
    const vt = await textStore.publishPolicy({ source: INVOICE_TEXT, format: "text" });
    textStore.setActiveVersion(vt.version);
    const textEval = new Evaluator({
      policyStore: textStore,
      relationshipStore: freshRelationships().asRelationshipStore(),
    });

    const structStore = new InMemoryPolicyStore();
    const vs = await structStore.publishPolicy({ source: APPROVAL_POLICY });
    structStore.setActiveVersion(vs.version);
    const structEval = new Evaluator({
      policyStore: structStore,
      relationshipStore: freshRelationships().asRelationshipStore(),
    });

    const matrix: Array<[Partial<Record<string, unknown>>, boolean]> = [
      [{}, false], // missing mfa → unknown → deny
      [{ mfa: false }, false],
      [{ mfa: true }, true],
      [{ mfa: true, unknown: "ignored" }, true], // untrusted keys are ignored
    ];
    for (const [ctx, expected] of matrix) {
      const dText = await textEval.check(
        { subject: "user:alice", action: "invoice.approve", resource: "invoice:1", context: ctx },
        { explanation: "none" },
      );
      const dStruct = await structEval.check(
        { subject: "user:alice", action: "invoice.approve", resource: "invoice:1", context: ctx },
        { explanation: "none" },
      );
      expect(dText.allowed, JSON.stringify(ctx)).toBe(expected);
      expect(dText.allowed).toBe(dStruct.allowed);
    }
  });
});

describe("policy language: malformed text is rejected at publish, never at evaluation", () => {
  it("rejects a parse error at publish", async () => {
    const store = new InMemoryPolicyStore();
    await expect(
      store.publishPolicy({
        source: "definition a { relation x: user permission p = oops }",
        format: "text",
      }),
    ).rejects.toThrow(PolicyStoreError);
    // and the evaluator fails closed — it has no active policy
    const evaluator = new Evaluator({
      policyStore: store,
      relationshipStore: new InMemoryRelationshipStore().asRelationshipStore(),
    });
    await expect(check(evaluator, "user:alice", "x.read", "x:1")).rejects.toThrow();
  });

  it("rejects an unterminated definition at publish", async () => {
    const store = new InMemoryPolicyStore();
    await expect(
      store.publishPolicy({ source: "definition a { relation x: user", format: "text" }),
    ).rejects.toThrow(PolicyStoreError);
  });

  it("rejects a policy that references an undeclared relation", async () => {
    const store = new InMemoryPolicyStore();
    await expect(
      store.publishPolicy({
        source: "definition a { permission p = ghost }",
        format: "text",
      }),
    ).rejects.toThrow(/undeclared relation/);
  });
});
