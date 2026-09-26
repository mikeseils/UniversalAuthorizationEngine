import { describe, expect, it } from "vitest";
import { AuthzClient, ValidationError, normalizeClientRequest } from "../packages/sdk/src/index.js";
import { ACME_POLICY, acmeSetup, publishAndActivate, readAcmePolicyText } from "./helpers.js";

describe("AuthzClient factory & request normalization (ADR-0015, ADR-0016)", () => {
  it("normalizes string subject and resource into parsed identifiers", () => {
    const normalized = normalizeClientRequest({
      subject: "user:alice",
      action: "document.read",
      resource: "document:123",
    });

    expect(normalized.subject).toEqual({ type: "user", id: "alice" });
    expect(normalized.action).toBe("document.read");
    expect(normalized.resource).toEqual({ type: "document", id: "123" });
  });

  it("normalizes structured subject and resource objects", () => {
    const normalized = normalizeClientRequest({
      subject: { type: "user", id: "alice" },
      action: "document.read",
      resource: { type: "document", id: "123" },
    });

    expect(normalized.subject).toEqual({ type: "user", id: "alice" });
    expect(normalized.resource).toEqual({ type: "document", id: "123" });
  });

  it("normalizes valid context dictionaries", () => {
    const normalized = normalizeClientRequest({
      subject: "user:alice",
      action: "document.read",
      resource: "document:123",
      context: { mfa: true, role: "admin" },
    });

    expect(normalized.context).toEqual({ mfa: true, role: "admin" });
  });

  it("rejects invalid subjects at the boundary with ValidationError", () => {
    expect(() =>
      normalizeClientRequest({
        subject: "invalid-subject-no-colon",
        action: "document.read",
        resource: "document:123",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects invalid actions at the boundary with ValidationError", () => {
    expect(() =>
      normalizeClientRequest({
        subject: "user:alice",
        action: "INVALID ACTION WITH SPACES",
        resource: "document:123",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects invalid resources at the boundary with ValidationError", () => {
    expect(() =>
      normalizeClientRequest({
        subject: "user:alice",
        action: "document.read",
        resource: "document:",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects array context at the boundary with ValidationError", () => {
    expect(() =>
      normalizeClientRequest({
        subject: "user:alice",
        action: "document.read",
        resource: "document:123",
        // @ts-expect-error test runtime validation of bad input
        context: ["not", "an", "object"],
      }),
    ).toThrow(ValidationError);
  });

  it("instantiates an in-memory client from text policy source", async () => {
    const client = await AuthzClient.inMemory({
      policy: readAcmePolicyText(),
      relationships: [{ subject: "user:alice", relation: "admin", resource: "organization:acme" }],
    });

    const result = await client.check({
      subject: "user:alice",
      action: "organization.manage",
      resource: "organization:acme",
    });

    expect(result.outcome).toBe("decision");
    if (result.outcome === "decision") {
      expect(result.decision.allowed).toBe(true);
    }
  });

  it("instantiates an in-memory client from structured policy source", async () => {
    const client = await AuthzClient.inMemory({
      policy: { source: ACME_POLICY },
      relationships: [{ subject: "user:alice", relation: "admin", resource: "organization:acme" }],
    });

    const result = await client.check({
      subject: "user:alice",
      action: "organization.manage",
      resource: "organization:acme",
    });

    expect(result.outcome).toBe("decision");
    if (result.outcome === "decision") {
      expect(result.decision.allowed).toBe(true);
    }
  });

  it("instantiates a client from an existing Evaluator instance", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const client = AuthzClient.fromEvaluator(setup.evaluator);

    const result = await client.check({
      subject: "user:alice",
      action: "document.read",
      resource: "document:a",
    });

    expect(result.outcome).toBe("decision");
    if (result.outcome === "decision") {
      expect(result.decision.allowed).toBe(true);
    }
  });
});
