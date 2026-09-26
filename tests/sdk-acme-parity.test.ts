import { describe, expect, it } from "vitest";
import { AuthzClient } from "../packages/sdk/src/index.js";
import { check, readAcmePolicyText } from "./helpers.js";
import { ACME_RELATIONSHIPS, parseFixtureLine } from "../examples/acme/fixture.js";
import { acmeSetup, publishAndActivate } from "./helpers.js";

describe("SDK parity with Evaluator over canonical Acme domain (ADR-0016)", () => {
  it("matches evaluator results across all canonical Acme checks", async () => {
    // 1. Raw evaluator setup
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const rawEvaluator = setup.evaluator;

    // 2. High-level SDK client setup using text policy and fixture relationships
    const sdkClient = await AuthzClient.inMemory({
      policy: readAcmePolicyText(),
      relationships: ACME_RELATIONSHIPS.map((line) => {
        const p = parseFixtureLine(line);
        return { subject: p.subject, relation: p.relation, resource: p.resource };
      }),
    });

    const testCases = [
      { subject: "user:alice", action: "organization.read", resource: "organization:acme" },
      { subject: "user:alice", action: "organization.manage", resource: "organization:acme" },
      { subject: "user:bob", action: "organization.read", resource: "organization:acme" },
      { subject: "user:bob", action: "organization.manage", resource: "organization:acme" },
      { subject: "user:alice", action: "project.read", resource: "project:alpha" },
      { subject: "user:alice", action: "project.write", resource: "project:alpha" },
      { subject: "user:alice", action: "project.delete", resource: "project:alpha" },
      { subject: "user:bob", action: "project.read", resource: "project:alpha" },
      { subject: "user:bob", action: "project.write", resource: "project:alpha" },
      { subject: "user:bob", action: "project.delete", resource: "project:alpha" },
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      { subject: "user:bob", action: "document.read", resource: "document:a" },
      { subject: "user:bob", action: "document.delete", resource: "document:a" },
      { subject: "user:carol", action: "document.read", resource: "document:a" },
      { subject: "user:carol", action: "document.delete", resource: "document:a" },
    ] as const;

    for (const testCase of testCases) {
      const rawDecision = await check(
        rawEvaluator,
        testCase.subject,
        testCase.action,
        testCase.resource,
      );

      const sdkOutcome = await sdkClient.check(testCase);
      expect(sdkOutcome.outcome).toBe("decision");
      if (sdkOutcome.outcome === "decision") {
        expect(
          sdkOutcome.decision.allowed,
          `Parity mismatch on ${testCase.subject} ${testCase.action} ${testCase.resource}`,
        ).toBe(rawDecision.allowed);
      }

      const isAllowed = await sdkClient.isAllowed(testCase);
      expect(isAllowed).toBe(rawDecision.allowed);
    }
  });
});
