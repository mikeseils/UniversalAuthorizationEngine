import { describe, expect, it } from "vitest";
import {
  AuthzClient,
  AuthorizationUnavailableError,
  ClientTransport,
} from "../packages/sdk/src/index.js";
import { Evaluator, InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import { InMemoryPolicyStore, PolicyStoreError } from "../packages/policy/src/index.js";
import { acmeSetup, publishAndActivate } from "./helpers.js";

describe("SDK Outcome Taxonomy: decision vs unavailable (ADR-0016)", () => {
  it("returns { outcome: 'decision' } for both ALLOW and DENY", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const client = AuthzClient.fromEvaluator(setup.evaluator);

    // Legitimate ALLOW
    const allowRes = await client.check({
      subject: "user:alice",
      action: "document.read",
      resource: "document:a",
    });
    expect(allowRes.outcome).toBe("decision");
    if (allowRes.outcome === "decision") {
      expect(allowRes.decision.allowed).toBe(true);
    }

    // Legitimate DENY (policy answered, no path exists)
    const denyRes = await client.check({
      subject: "user:bob",
      action: "document.delete",
      resource: "document:a",
    });
    expect(denyRes.outcome).toBe("decision");
    if (denyRes.outcome === "decision") {
      expect(denyRes.decision.allowed).toBe(false);
      expect(denyRes.decision.reason).toBe("policy_deny");
    }
  });

  it("returns { outcome: 'unavailable' } when the policy store fails", async () => {
    const emptyPolicyStore = new InMemoryPolicyStore(); // no active policy activated
    const relationshipStore = new InMemoryRelationshipStore();
    const evaluator = new Evaluator({
      policyStore: emptyPolicyStore,
      relationshipStore: relationshipStore.asRelationshipStore(),
    });
    const client = AuthzClient.fromEvaluator(evaluator);

    const result = await client.check({
      subject: "user:alice",
      action: "document.read",
      resource: "document:a",
    });

    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.error).toBeInstanceOf(AuthorizationUnavailableError);
      expect(result.error.reason).toBe("policy_store_error");
      expect(result.error.cause).toBeInstanceOf(PolicyStoreError);
    }
  });

  it("returns { outcome: 'unavailable' } when the relationship store throws", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);

    const brokenRelationshipStore = {
      getRelationships: () => Promise.reject(new Error("relationship store offline")),
    };

    const evaluator = new Evaluator({
      policyStore: setup.policyStore,
      relationshipStore: brokenRelationshipStore,
    });
    const client = AuthzClient.fromEvaluator(evaluator);

    const result = await client.check({
      subject: "user:alice",
      action: "document.read",
      resource: "document:a",
    });

    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.error).toBeInstanceOf(AuthorizationUnavailableError);
      expect(result.error.reason).toBe("relationship_store_error");
      expect(result.error.message).toContain("relationship store offline");
    }
  });

  it("isAllowed returns boolean on decision", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const client = AuthzClient.fromEvaluator(setup.evaluator);

    expect(
      await client.isAllowed({
        subject: "user:alice",
        action: "document.read",
        resource: "document:a",
      }),
    ).toBe(true);

    expect(
      await client.isAllowed({
        subject: "user:bob",
        action: "document.delete",
        resource: "document:a",
      }),
    ).toBe(false);
  });

  it("isAllowed throws AuthorizationUnavailableError on engine failure by default", async () => {
    const failingTransport: ClientTransport = {
      check: () =>
        Promise.resolve({
          outcome: "unavailable",
          error: new AuthorizationUnavailableError("transport_error", "network partitioned"),
        }),
      checkBatch: () => Promise.resolve([]),
    };
    const client = new AuthzClient(failingTransport);

    await expect(
      client.isAllowed({
        subject: "user:alice",
        action: "document.read",
        resource: "document:a",
      }),
    ).rejects.toThrow(AuthorizationUnavailableError);
  });

  it("isAllowed safely fails closed to false when opted into onUnavailable: 'deny'", async () => {
    const failingTransport: ClientTransport = {
      check: () =>
        Promise.resolve({
          outcome: "unavailable",
          error: new AuthorizationUnavailableError("transport_error", "network partitioned"),
        }),
      checkBatch: () => Promise.resolve([]),
    };
    const client = new AuthzClient(failingTransport);

    const allowed = await client.isAllowed(
      {
        subject: "user:alice",
        action: "document.read",
        resource: "document:a",
      },
      { onUnavailable: "deny" },
    );

    expect(allowed).toBe(false);
  });
});
