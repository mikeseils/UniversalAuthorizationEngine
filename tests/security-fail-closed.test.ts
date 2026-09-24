import { describe, expect, it } from "vitest";
import { Evaluator, InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import { InMemoryPolicyStore, PolicyStoreError } from "../packages/policy/src/index.js";
import { acmeSetup, check, publishAndActivate } from "./helpers.js";

describe("fail-closed error paths (ADR-0006, ADR-0010)", () => {
  it("malformed requests are rejected at the boundary, never evaluated", async () => {
    const { evaluator, policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    await expect(
      evaluator.check({ subject: "alice", action: "read", resource: "document:a" }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    await expect(
      evaluator.check({ subject: "user:alice", action: "BAD ACTION", resource: "document:a" }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    await expect(
      evaluator.check({ subject: "user:alice", action: "read", resource: "nodocument" }),
    ).rejects.toMatchObject({ name: "ValidationError" });
  });

  it("infrastructure failure (store throws) is a typed error, not a DENY-and-swallow", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const throwingStore = {
      getRelationships: () => Promise.reject(new Error("relationship store down")),
    };
    const evaluator = new Evaluator({ policyStore, relationshipStore: throwingStore });
    await expect(
      evaluator.check({ subject: "user:alice", action: "project.read", resource: "project:alpha" }),
    ).rejects.toThrow(/relationship store down/);
  });

  it("defective loaded policy artifact → explained DENY with reason 'error'", async () => {
    const { evaluator, policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    // Simulate tampered/corrupt artifact stored under an activated version.
    (
      policyStore as unknown as {
        versions: Map<string, unknown>;
      }
    ).versions.set("bad", { version: "bad", hash: "x", artifact: { definitions: "garbage" } });
    (policyStore as unknown as { activeVersion: string | null }).activeVersion = "bad";
    const decision = await check(evaluator, "user:alice", "project.read", "project:alpha");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("error");
    const explained = await evaluator.check(
      { subject: "user:alice", action: "project.read", resource: "project:alpha" },
      { explanation: "debug" },
    );
    expect(JSON.stringify(explained.explanation)).toMatch(/defective policy artifact/);
  });

  it("no active policy is a typed infrastructure error, not an ALLOW", async () => {
    const { relationships } = acmeSetup();
    const fresh = new Evaluator({
      policyStore: new InMemoryPolicyStore(),
      relationshipStore: relationships.asRelationshipStore(),
    });
    await expect(
      fresh.check({ subject: "user:alice", action: "read", resource: "document:a" }),
    ).rejects.toThrow(PolicyStoreError);
  });

  it("oversized batches are rejected at the boundary", async () => {
    const { evaluator, policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const oversized = Array.from({ length: 101 }, () => ({
      subject: "user:alice",
      action: "document.read",
      resource: "document:a",
    }));
    await expect(evaluator.checkBatch(oversized)).rejects.toThrow(/maxBatchSize/);
  });

  it("the in-memory store is idempotent and removals are safe to retry", () => {
    const store = new InMemoryRelationshipStore();
    const rel = { subject: "user:alice", relation: "editor", resource: "project:123" };
    store.add(rel);
    store.add(rel);
    store.add(rel);
    expect(store.size).toBe(1);
    expect(store.remove(rel)).toBe(true);
    expect(store.remove(rel)).toBe(false);
    expect(store.size).toBe(0);
  });
});
