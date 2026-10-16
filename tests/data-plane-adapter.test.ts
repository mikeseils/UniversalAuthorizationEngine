import { describe, expect, it } from "vitest";
import { InMemoryPolicyStore } from "../packages/policy/src/store.js";
import { Evaluator, InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import {
  EvaluatorAdapter,
  type ClientRequest,
} from "../packages/data-plane/src/evaluator-adapter.js";
import { ACME_POLICY, publishAndActivate } from "./helpers.js";

const req = (subject: string, action: string, resource: string): ClientRequest => ({
  subject,
  action,
  resource,
});

describe("EvaluatorAdapter", () => {
  it("returns a decision outcome for an allowed check", async () => {
    const { policyStore, relationships } = await setup();
    const adapter = new EvaluatorAdapter(
      new Evaluator({
        policyStore,
        relationshipStore: relationships.asRelationshipStore(),
      }),
    );

    const outcome = await adapter.check(
      req("user:member_0_0", "document.read", "document:doc_0_0_0"),
    );
    expect(outcome.outcome).toBe("decision");
    if (outcome.outcome === "decision") {
      expect(outcome.decision.allowed).toBe(true);
    }
  });

  it("returns a decision outcome for a denied check", async () => {
    const { policyStore, relationships } = await setup();
    const adapter = new EvaluatorAdapter(
      new Evaluator({
        policyStore,
        relationshipStore: relationships.asRelationshipStore(),
      }),
    );

    // user:member_0_1 is editor on project_0_0 but not on project_0_1
    const outcome = await adapter.check(
      req("user:member_0_1", "document.read", "document:doc_0_1_0"),
    );
    expect(outcome.outcome).toBe("decision");
    if (outcome.outcome === "decision") {
      // member_0_1 is viewer on project_0_0 only, not project_0_1
      // Actually let's check: member_0_1 is editor on proj_0_0, and doc_0_1_0 is in proj_0_1
      // member_0_1 has no relation to proj_0_1, so this should be denied
      expect(outcome.decision.allowed).toBe(false);
    }
  });

  it("returns unavailable for a malformed request", async () => {
    const { policyStore, relationships } = await setup();
    const adapter = new EvaluatorAdapter(
      new Evaluator({
        policyStore,
        relationshipStore: relationships.asRelationshipStore(),
      }),
    );

    // Bad subject format should throw at the boundary
    const outcome = await adapter.check({
      subject: "",
      action: "document.read",
      resource: "document:a",
    });
    expect(outcome.outcome).toBe("unavailable");
  });

  it("evaluates a batch with per-item outcomes", async () => {
    const { policyStore, relationships } = await setup();
    const adapter = new EvaluatorAdapter(
      new Evaluator({
        policyStore,
        relationshipStore: relationships.asRelationshipStore(),
      }),
    );

    const outcomes = await adapter.checkBatch([
      req("user:member_0_0", "document.read", "document:doc_0_0_0"),
      req("user:member_0_1", "document.read", "document:doc_0_1_0"),
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.outcome).toBe("decision");
    expect(outcomes[1]?.outcome).toBe("decision");
  });
});

async function setup() {
  const policyStore = new InMemoryPolicyStore();
  const relationships = new InMemoryRelationshipStore();
  // Build a small acme graph: org_0 -> proj_0_0 -> doc_0_0_0, proj_0_1 -> doc_0_1_0
  relationships.add({
    subject: "organization:org_0",
    relation: "owns",
    resource: "project:proj_0_0",
  });
  relationships.add({
    subject: "organization:org_0",
    relation: "owns",
    resource: "project:proj_0_1",
  });
  relationships.add({
    subject: "user:member_0_0",
    relation: "owner",
    resource: "project:proj_0_0",
  });
  relationships.add({
    subject: "user:member_0_0",
    relation: "owner",
    resource: "project:proj_0_1",
  });
  relationships.add({
    subject: "user:member_0_1",
    relation: "editor",
    resource: "project:proj_0_0",
  });
  relationships.add({
    subject: "project:proj_0_0",
    relation: "contains",
    resource: "document:doc_0_0_0",
  });
  relationships.add({
    subject: "project:proj_0_1",
    relation: "contains",
    resource: "document:doc_0_1_0",
  });
  await publishAndActivate(policyStore, { source: ACME_POLICY });
  return { policyStore, relationships };
}
