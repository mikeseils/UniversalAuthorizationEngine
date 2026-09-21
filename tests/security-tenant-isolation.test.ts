import { describe, expect, it } from "vitest";
import { acmeSetup, check, publishAndActivate } from "./helpers.js";

const setup = async () => {
  const { evaluator, policyStore, relationships } = acmeSetup();
  await publishAndActivate(policyStore);
  return { evaluator, relationships };
};

/**
 * Tenant isolation is a binding invariant (docs/security/threat-model.md #3).
 * Acme (organization:acme) vs Beta (organization:beta).
 */
describe("tenant isolation", () => {
  it("membership in one tenant never grants access in another", async () => {
    const { evaluator, relationships } = await setup();
    // Carol belongs only to Beta
    relationships.add({ subject: "user:carol", relation: "member", resource: "organization:beta" });
    relationships.add({ subject: "organization:beta", relation: "owns", resource: "project:beta" });
    relationships.add({ subject: "user:carol", relation: "owner", resource: "project:beta" });

    // Carol's valid Beta permissions...
    expect((await check(evaluator, "user:carol", "project.read", "project:beta")).allowed).toBe(
      true,
    );
    // ...must not leak into Acme
    expect((await check(evaluator, "user:carol", "project.read", "project:alpha")).allowed).toBe(
      false,
    );
    expect((await check(evaluator, "user:carol", "document.read", "document:a")).allowed).toBe(
      false,
    );
  });

  it("identically-named resources across tenants do not collide", async () => {
    const { evaluator, relationships } = await setup();
    // Carol views a resource in a *different* tenant; the identically-shaped
    // Acme resources must remain out of reach.
    relationships.add({ subject: "user:carol", relation: "viewer", resource: "project:zeta" });
    expect((await check(evaluator, "user:carol", "project.read", "project:zeta")).allowed).toBe(
      true,
    );
    expect((await check(evaluator, "user:carol", "project.read", "project:alpha")).allowed).toBe(
      false,
    );
    expect((await check(evaluator, "user:carol", "document.read", "document:b")).allowed).toBe(
      false,
    );
  });

  it("service identities are scoped like any other subject", async () => {
    const { evaluator, relationships } = await setup();
    relationships.add({
      subject: "service:billing",
      relation: "member",
      resource: "organization:beta",
    });
    expect(
      (await check(evaluator, "service:billing", "organization.read", "organization:beta")).allowed,
    ).toBe(true);
    expect(
      (await check(evaluator, "service:billing", "organization.read", "organization:acme")).allowed,
    ).toBe(false);
  });

  it("cross-tenant write attempts deny", async () => {
    const { evaluator, relationships } = await setup();
    relationships.add({ subject: "user:carol", relation: "editor", resource: "project:beta" });
    expect((await check(evaluator, "user:carol", "project.write", "project:beta")).allowed).toBe(
      true,
    );
    expect((await check(evaluator, "user:carol", "project.write", "project:alpha")).allowed).toBe(
      false,
    );
  });
});
