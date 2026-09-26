import { describe, expect, it } from "vitest";
import {
  AuthzClient,
  AuthorizationUnavailableError,
  ClientTransport,
  ValidationError,
} from "../packages/sdk/src/index.js";
import { acmeSetup, publishAndActivate } from "./helpers.js";

describe("SDK Batch checks: limits & per-item isolation (ADR-0016)", () => {
  it("rejects batches larger than maxBatchSize with ValidationError", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const client = AuthzClient.fromEvaluator(setup.evaluator);

    const oversized = Array.from({ length: 101 }, (_, i) => ({
      subject: `user:u${String(i)}`,
      action: "document.read",
      resource: "document:a",
    }));

    await expect(client.checkBatch(oversized)).rejects.toThrow(ValidationError);
  });

  it("rejects batches with any malformed request before execution", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const client = AuthzClient.fromEvaluator(setup.evaluator);

    const batch = [
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      { subject: "MALFORMED_NO_COLON", action: "document.read", resource: "document:a" },
    ];

    await expect(client.checkBatch(batch)).rejects.toThrow(ValidationError);
  });

  it("evaluates batches with 1:1 positional parity", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const client = AuthzClient.fromEvaluator(setup.evaluator);

    const requests = [
      { subject: "user:alice", action: "document.read", resource: "document:a" }, // allow
      { subject: "user:bob", action: "document.delete", resource: "document:a" }, // deny
      { subject: "user:alice", action: "organization.manage", resource: "organization:acme" }, // allow
    ];

    const outcomes = await client.checkBatch(requests);
    expect(outcomes).toHaveLength(3);

    expect(outcomes[0]?.outcome).toBe("decision");
    if (outcomes[0]?.outcome === "decision") {
      expect(outcomes[0].decision.allowed).toBe(true);
    }

    expect(outcomes[1]?.outcome).toBe("decision");
    if (outcomes[1]?.outcome === "decision") {
      expect(outcomes[1].decision.allowed).toBe(false);
    }

    expect(outcomes[2]?.outcome).toBe("decision");
    if (outcomes[2]?.outcome === "decision") {
      expect(outcomes[2].decision.allowed).toBe(true);
    }
  });

  it("isolates errors per item so partial transport failures do not drop companion decisions", async () => {
    const mockTransport: ClientTransport = {
      check: (req) => {
        const id = typeof req.resource === "string" ? req.resource : req.resource.id;
        if (id.includes("broken")) {
          return Promise.resolve({
            outcome: "unavailable",
            error: new AuthorizationUnavailableError(
              "transport_error",
              "timeout fetching resource",
            ),
          });
        }
        return Promise.resolve({
          outcome: "decision",
          decision: { allowed: true },
        });
      },
      checkBatch: async function (reqs, opts) {
        const results = [];
        for (const req of reqs) {
          results.push(await this.check(req, opts));
        }
        return results;
      },
    };

    const client = new AuthzClient(mockTransport);

    const outcomes = await client.checkBatch([
      { subject: "user:alice", action: "document.read", resource: "document:ok-1" },
      { subject: "user:alice", action: "document.read", resource: "document:broken" },
      { subject: "user:alice", action: "document.read", resource: "document:ok-2" },
    ]);

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]?.outcome).toBe("decision");
    expect(outcomes[1]?.outcome).toBe("unavailable");
    expect(outcomes[2]?.outcome).toBe("decision");

    if (outcomes[1]?.outcome === "unavailable") {
      expect(outcomes[1].error.reason).toBe("transport_error");
    }
  });
});
