import { describe, expect, it } from "vitest";
import { PolicyNotFoundError } from "../packages/core/src/index.js";
import { anyOf, relationRef } from "../packages/policy/src/index.js";
import { AuthzClient } from "../packages/sdk/src/index.js";
import { ACME_POLICY, acmeSetup, check, publishAndActivate } from "./helpers.js";

/**
 * Policy version pinning (ADR-0019).
 *
 * The Phase 4 deferral: `getPolicyVersion` existed but nothing reached it.
 * Pinning makes a decision reproducible against the exact artifact that
 * produced it — the property audits, debugging, and rollback all depend on.
 */

/** A second policy that narrows project.write to owners only. */
const TIGHTER_POLICY = {
  definitions: {
    ...ACME_POLICY.definitions,
    project: {
      relations: { ...ACME_POLICY.definitions["project"]?.relations },
      permissions: {
        // Deliberately narrower than ACME_POLICY: only owners may write.
        write: anyOf(relationRef("owner")),
      },
    },
  },
};

describe("policy version pinning", () => {
  it("defaults to the active version when no version is pinned", async () => {
    const setup = acmeSetup();
    const first = await publishAndActivate(setup.policyStore);
    const decision = await check(setup.evaluator, "user:alice", "project.write", "project:alpha");
    expect(decision.policyVersion).toBe(first);
  });

  it("evaluates against the pinned version, not the active one", async () => {
    const setup = acmeSetup();
    const v1 = await publishAndActivate(setup.policyStore);
    const v2 = await setup.policyStore.publishPolicy({ source: TIGHTER_POLICY });
    setup.policyStore.setActiveVersion(v2.version);

    // Active (v2): alice is owner, so write is allowed.
    expect(
      (await check(setup.evaluator, "user:alice", "project.write", "project:alpha")).allowed,
    ).toBe(true);
    // Pinned to v1 — the same request, the same relationships, an older policy.
    const pinned = await setup.evaluator.check(
      { subject: "user:alice", action: "project.write", resource: "project:alpha" },
      { policyVersion: v1 },
    );
    expect(pinned.policyVersion).toBe(v1);
    expect(pinned.allowed).toBe(true);
  });

  it("an unknown version throws PolicyNotFoundError and never falls back", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    // Falling back to the active version would produce a decision attributed to
    // a policy that did not produce it — the exact corruption pinning prevents.
    await expect(
      setup.evaluator.check(
        { subject: "user:alice", action: "project.read", resource: "project:alpha" },
        { policyVersion: "999" },
      ),
    ).rejects.toBeInstanceOf(PolicyNotFoundError);
  });

  it("every decision cites the version that produced it", async () => {
    const setup = acmeSetup();
    const v1 = await publishAndActivate(setup.policyStore);
    for (const [subject, action, resource] of [
      ["user:alice", "project.read", "project:alpha"],
      ["user:bob", "project.read", "project:alpha"],
      ["user:bob", "project.delete", "project:alpha"],
    ] as const) {
      const active = await check(setup.evaluator, subject, action, resource);
      const pinned = await setup.evaluator.check(
        { subject, action, resource },
        { policyVersion: v1 },
      );
      expect(pinned.policyVersion).toBe(v1);
      expect(pinned.allowed).toBe(active.allowed);
      expect(pinned.reason).toBe(active.reason);
    }
  });

  it("the SDK surfaces an unknown pinned version as a caller error, not unavailability", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const client = AuthzClient.fromEvaluator(setup.evaluator);
    // Reporting this as `unavailable` would tell the application the engine is
    // broken when it merely asked for a version that never existed.
    await expect(
      client.check(
        { subject: "user:alice", action: "project.read", resource: "project:alpha" },
        { policyVersion: "999" },
      ),
    ).rejects.toBeInstanceOf(PolicyNotFoundError);
  });

  it("the SDK returns a decision when the pinned version exists", async () => {
    const setup = acmeSetup();
    const v1 = await publishAndActivate(setup.policyStore);
    const client = AuthzClient.fromEvaluator(setup.evaluator);
    const outcome = await client.check(
      { subject: "user:alice", action: "project.read", resource: "project:alpha" },
      { policyVersion: v1 },
    );
    expect(outcome.outcome).toBe("decision");
    if (outcome.outcome === "decision") {
      expect(outcome.decision.policyVersion).toBe(v1);
    }
  });
});
