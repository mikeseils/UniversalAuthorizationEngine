import { describe, expect, it } from "vitest";
import { ValidationError } from "../packages/core/src/errors.js";
import { InMemoryPolicyStore } from "../packages/policy/src/store.js";
import { Evaluator, InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import { DataPlaneServer } from "../packages/data-plane/src/server.js";
import { HttpTransport, AuthzClient } from "../packages/sdk/src/index.js";
import { ACME_POLICY, publishAndActivate } from "./helpers.js";

describe("HttpTransport", () => {
  it("sends check and receives a decision", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const transport = new HttpTransport(`http://127.0.0.1:${String(addr.port)}`);
      const outcome = await transport.check({
        subject: { type: "user", id: "member_0_0" },
        action: "document.read",
        resource: { type: "document", id: "doc_0_0_0" },
      });
      expect(outcome.outcome).toBe("decision");
      if (outcome.outcome === "decision") {
        expect(outcome.decision.allowed).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it("returns unavailable when the data plane errors", async () => {
    // A genuine infrastructure failure (no active policy) → 503 → unavailable.
    const policyStore = new InMemoryPolicyStore();
    const relationships = new InMemoryRelationshipStore();
    const evaluator = new Evaluator({
      policyStore,
      relationshipStore: relationships.asRelationshipStore(),
    });
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const transport = new HttpTransport(`http://127.0.0.1:${String(addr.port)}`);
      const outcome = await transport.check({
        subject: "user:alice",
        action: "document.read",
        resource: "document:a",
      });
      expect(outcome.outcome).toBe("unavailable");
    } finally {
      await server.close();
    }
  });

  it("reports malformed check requests as ValidationError (400, not unavailable)", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const transport = new HttpTransport(`http://127.0.0.1:${String(addr.port)}`);
      // Empty subject is rejected at the boundary with 400 → caller error.
      await expect(
        transport.check({
          subject: "",
          action: "document.read",
          resource: "document:a",
        }),
      ).rejects.toThrow(ValidationError);
    } finally {
      await server.close();
    }
  });

  it("checkBatch returns per-item outcomes", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const transport = new HttpTransport(`http://127.0.0.1:${String(addr.port)}`);
      const outcomes = await transport.checkBatch([
        {
          subject: { type: "user", id: "member_0_0" },
          action: "document.read",
          resource: { type: "document", id: "doc_0_0_0" },
        },
        {
          subject: { type: "user", id: "member_0_1" },
          action: "document.read",
          resource: { type: "document", id: "doc_0_1_0" },
        },
      ]);
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]?.outcome).toBe("decision");
      expect(outcomes[1]?.outcome).toBe("decision");
    } finally {
      await server.close();
    }
  });

  it("AuthzClient.fromTransport works end-to-end", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const client = AuthzClient.fromTransport(`http://127.0.0.1:${String(addr.port)}`);
      const result = await client.check({
        subject: "user:member_0_0",
        action: "document.read",
        resource: "document:doc_0_0_0",
      });
      expect(result.outcome).toBe("decision");
      if (result.outcome === "decision") {
        expect(result.decision.allowed).toBe(true);
      }
    } finally {
      await server.close();
    }
  });
});

async function setup() {
  const policyStore = new InMemoryPolicyStore();
  const relationships = new InMemoryRelationshipStore();
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
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: relationships.asRelationshipStore(),
  });
  return { evaluator };
}
