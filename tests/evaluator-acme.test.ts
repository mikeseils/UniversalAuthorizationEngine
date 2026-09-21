import { describe, expect, it } from "vitest";
import { acmeSetup, check, publishAndActivate } from "./helpers.js";

const setup = async () => {
  const { evaluator, policyStore, relationships } = acmeSetup();
  const version = await publishAndActivate(policyStore);
  return { evaluator, policyStore, relationships, version };
};

describe("evaluator over the canonical Acme domain", () => {
  it("grants RBAC org permissions", async () => {
    const { evaluator } = await setup();
    expect(
      (await check(evaluator, "user:alice", "organization.read", "organization:acme")).allowed,
    ).toBe(true);
    expect(
      (await check(evaluator, "user:alice", "organization.manage", "organization:acme")).allowed,
    ).toBe(true);
    expect(
      (await check(evaluator, "user:bob", "organization.read", "organization:acme")).allowed,
    ).toBe(true);
    expect(
      (await check(evaluator, "user:bob", "organization.manage", "organization:acme")).allowed,
    ).toBe(false);
  });

  it("grants project roles (owner > editor > viewer)", async () => {
    const { evaluator } = await setup();
    expect((await check(evaluator, "user:alice", "project.read", "project:alpha")).allowed).toBe(
      true,
    );
    expect((await check(evaluator, "user:alice", "project.write", "project:alpha")).allowed).toBe(
      true,
    );
    expect((await check(evaluator, "user:alice", "project.delete", "project:alpha")).allowed).toBe(
      true,
    );
    expect((await check(evaluator, "user:bob", "project.read", "project:alpha")).allowed).toBe(
      true,
    );
    expect((await check(evaluator, "user:bob", "project.write", "project:alpha")).allowed).toBe(
      false,
    );
    expect((await check(evaluator, "user:bob", "project.delete", "project:alpha")).allowed).toBe(
      false,
    );
  });

  it("inherits document permissions from the containing project (ReBAC)", async () => {
    const { evaluator } = await setup();
    // Alice owns project:alpha → contains document:a → document.read ALLOW
    expect((await check(evaluator, "user:alice", "document.read", "document:a")).allowed).toBe(
      true,
    );
    // Bob views project:alpha → document read ALLOW, delete DENY
    expect((await check(evaluator, "user:bob", "document.read", "document:a")).allowed).toBe(true);
    expect((await check(evaluator, "user:bob", "document.delete", "document:a")).allowed).toBe(
      false,
    );
    // Alice's org-admin `manage` inherits to project delete, and via contains to document delete
    expect((await check(evaluator, "user:alice", "document.delete", "document:a")).allowed).toBe(
      true,
    );
  });

  it("denies unrelated subjects on every layer", async () => {
    const { evaluator } = await setup();
    for (const [subject, action, resource] of [
      ["user:carol", "document.read", "document:a"],
      ["user:carol", "project.read", "project:alpha"],
      ["user:carol", "organization.read", "organization:acme"],
      ["user:bob", "document.delete", "document:b"],
    ] as const) {
      const decision = await check(evaluator, subject, action, resource);
      expect(decision.allowed, `${subject} ${action} ${resource}`).toBe(false);
      expect(decision.reason).toBe("policy_deny");
    }
  });

  it("revoking required relationships flips allow to deny", async () => {
    const { evaluator, relationships } = await setup();
    // Bob reads document:a via project viewer AND via org membership
    // (member → organization read → owns → project read). Both paths must go.
    relationships.remove({ subject: "user:bob", relation: "viewer", resource: "project:alpha" });
    expect((await check(evaluator, "user:bob", "document.read", "document:a")).allowed).toBe(true);
    relationships.remove({
      subject: "user:bob",
      relation: "member",
      resource: "organization:acme",
    });
    expect((await check(evaluator, "user:bob", "document.read", "document:a")).allowed).toBe(false);
  });

  it("adding an unrelated relationship never grants access", async () => {
    const { evaluator, relationships } = await setup();
    relationships.add({ subject: "user:carol", relation: "viewer", resource: "project:beta" });
    relationships.add({ subject: "user:carol", relation: "member", resource: "organization:beta" });
    expect((await check(evaluator, "user:carol", "document.read", "document:a")).allowed).toBe(
      false,
    );
    expect((await check(evaluator, "user:carol", "project.read", "project:alpha")).allowed).toBe(
      false,
    );
  });

  it("decisions cite the exact policy version", async () => {
    const { evaluator, version } = await setup();
    const decision = await check(evaluator, "user:alice", "project.read", "project:alpha");
    expect(decision.policyVersion).toBe(version);
  });
});
