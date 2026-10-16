import { describe, expect, it } from "vitest";
import { InMemoryPolicyStore } from "../packages/policy/src/store.js";
import { Evaluator, InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import { DataPlaneServer } from "../packages/data-plane/src/server.js";
import { ACME_POLICY, publishAndActivate } from "./helpers.js";

describe("DataPlaneServer", () => {
  it("answers check requests over HTTP", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "user:member_0_0",
          action: "document.read",
          resource: "document:doc_0_0_0",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect((body as { outcome: string }).outcome).toBe("decision");
      expect((body as { decision: { allowed: boolean } }).decision.allowed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("answers checkBatch requests over HTTP", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/checkBatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { subject: "user:member_0_0", action: "document.read", resource: "document:doc_0_0_0" },
          { subject: "user:member_0_1", action: "document.read", resource: "document:doc_0_1_0" },
        ]),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("healthz returns ok", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/healthz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect((body as { status: string }).status).toBe("ok");
    } finally {
      await server.close();
    }
  });

  it("returns 503 for unavailable outcomes", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      // Empty subject → boundary error → unavailable → 503
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "",
          action: "document.read",
          resource: "document:a",
        }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect((body as { outcome: string }).outcome).toBe("unavailable");
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
