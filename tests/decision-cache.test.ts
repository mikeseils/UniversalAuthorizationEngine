import { describe, expect, it } from "vitest";
import { ExplanationLevel, ValidationError } from "../packages/core/src/index.js";
import { DecisionCache, Evaluator, decisionCacheKey } from "../packages/evaluator/src/index.js";
import { InMemoryPolicyStore } from "../packages/policy/src/index.js";
import { APPROVAL_POLICY, acmeSetup, publishAndActivate } from "./helpers.js";

/**
 * Decision cache: functional behavior (ADR-0021) and its security properties
 * (threat-model rows 4/5, `docs/architecture/caching.md` rules 1–5).
 *
 * The security claims are the point: a version-keyed cache must never serve a
 * decision the current state does not support — not after revocation, not
 * across contexts, not across subjects, not after mutation by a caller.
 */

const ALLOWING = {
  subject: "user:bob",
  action: "project.read",
  resource: "project:alpha",
} as const;

async function cachedSetup(cache = new DecisionCache()) {
  const setup = acmeSetup();
  await publishAndActivate(setup.policyStore, setup.policy);
  const stages: string[] = [];
  const evaluator = new Evaluator({
    policyStore: setup.policyStore,
    relationshipStore: setup.relationships.asRelationshipStore(),
    decisionCache: cache,
    observer: (event) => stages.push(event.stage),
  });
  return { ...setup, cache, evaluator, stages };
}

describe("DecisionCache (ADR-0021)", () => {
  // --- key construction -----------------------------------------------------
  it("keys separate every input that can change a decision", () => {
    const base = {
      subject: { type: "user", id: "alice" },
      action: "project.read",
      resource: { type: "project", id: "alpha" },
      policyVersion: "v1",
      relationshipVersion: "7",
      explanationLevel: "none" as ExplanationLevel,
      context: {},
    };
    const key = decisionCacheKey(base);
    const variants: Partial<typeof base>[] = [
      { subject: { type: "user", id: "bob" } },
      { action: "project.write" },
      { resource: { type: "project", id: "beta" } },
      { policyVersion: "v2" },
      { relationshipVersion: "8" }, // opaque token: a different string, nothing more
      { explanationLevel: "debug" },
      { context: { mfa: true } },
    ];
    for (const variant of variants) {
      expect(decisionCacheKey({ ...base, ...variant })).not.toBe(key);
    }
    expect(decisionCacheKey(base)).toBe(key);
  });

  it("is insensitive to context key order (canonical JSON)", () => {
    const base = {
      subject: { type: "user", id: "alice" },
      action: "invoice.approve",
      resource: { type: "invoice", id: "1" },
      policyVersion: "v1",
      relationshipVersion: "1",
      explanationLevel: "none" as const,
      context: {},
    };
    expect(decisionCacheKey({ ...base, context: { a: 1, b: { c: 2, d: 3 } } })).toBe(
      decisionCacheKey({ ...base, context: { b: { d: 3, c: 2 }, a: 1 } }),
    );
  });

  // --- cache mechanics ------------------------------------------------------
  it("refuses to store error decisions (ADR-0021 §3)", () => {
    const cache = new DecisionCache();
    expect(cache.set("k", { allowed: false, reason: "error" })).toBe(false);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.set("k", { allowed: false, reason: "policy_deny" })).toBe(true);
    expect(cache.get("k")).toEqual({ allowed: false, reason: "policy_deny" });
  });

  it("serves entries until TTL, then treats them as a miss", () => {
    let now = 1000;
    const cache = new DecisionCache({ ttlMs: 100, now: () => now });
    cache.set("k", { allowed: true, reason: "policy_allow" });
    now += 99;
    expect(cache.get("k")).toBeDefined();
    now += 1;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it("evicts least-recently-used entries beyond maxEntries", () => {
    const cache = new DecisionCache({ maxEntries: 2 });
    cache.set("a", { allowed: true, reason: "policy_allow" });
    cache.set("b", { allowed: true, reason: "policy_allow" });
    expect(cache.get("a")).toBeDefined(); // refresh a: b is now least recent
    cache.set("c", { allowed: true, reason: "policy_allow" });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("rejects nonsensical bounds instead of silently disabling itself", () => {
    expect(() => new DecisionCache({ maxEntries: 0 })).toThrow(ValidationError);
    expect(() => new DecisionCache({ ttlMs: 0 })).toThrow(ValidationError);
  });
});

describe("decision cache integration (ADR-0021)", () => {
  it("serves the second identical check from the cache", async () => {
    const { evaluator, cache, stages } = await cachedSetup();
    const first = await evaluator.check(ALLOWING);
    const second = await evaluator.check(ALLOWING);
    expect(second).toEqual(first);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
    expect(stages.filter((s) => s === "cache:miss")).toHaveLength(1);
    expect(stages.filter((s) => s === "cache:hit")).toHaveLength(1);
  });

  it("without a configured cache, behavior is unchanged (no cache stages)", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore, setup.policy);
    const stages: string[] = [];
    const evaluator = new Evaluator({
      policyStore: setup.policyStore,
      relationshipStore: setup.relationships.asRelationshipStore(),
      observer: (event) => stages.push(event.stage),
    });
    await evaluator.check(ALLOWING);
    await evaluator.check(ALLOWING);
    expect(stages.some((s) => s.startsWith("cache:"))).toBe(false);
  });

  it("refuses a cache when the store cannot report a version (S11)", () => {
    expect(
      () =>
        new Evaluator({
          policyStore: new InMemoryPolicyStore(),
          relationshipStore: { getRelationships: () => Promise.resolve([]) },
          decisionCache: new DecisionCache(),
        }),
    ).toThrow(ValidationError);
  });

  it("keys explanations separately: a level change re-evaluates", async () => {
    const { evaluator, cache } = await cachedSetup();
    const bare = await evaluator.check(ALLOWING, { explanation: "none" });
    expect(bare.explanation).toBeUndefined();
    const explained = await evaluator.check(ALLOWING, { explanation: "standard" });
    expect(explained.explanation).toBeDefined();
    // Distinct keys: two entries, no cross-level contamination.
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, size: 2 });
  });

  it("a policy change invalidates entries through the policy version segment", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore, setup.policy);
    const cache = new DecisionCache();
    const evaluator = new Evaluator({
      policyStore: setup.policyStore,
      relationshipStore: setup.relationships.asRelationshipStore(),
      decisionCache: cache,
    });
    const before = await evaluator.check(ALLOWING);
    expect(before.policyVersion).toBeDefined();

    // Republish the identical source: S8 mints a NEW version, so the same
    // request must not be answerable from the v1 entry.
    await publishAndActivate(setup.policyStore, setup.policy);
    const after = await evaluator.check(ALLOWING);
    expect(after.policyVersion).not.toBe(before.policyVersion);
    expect(cache.stats().hits).toBe(0);
  });
});

describe("decision cache security properties (threat model rows 4–5)", () => {
  it("revocation is immediate: a cached ALLOW is never served after the edge goes", async () => {
    const { evaluator, relationships, cache } = await cachedSetup();
    const grant = { subject: "user:carol", relation: "viewer", resource: "project:alpha" };
    relationships.add(grant);
    const request = { subject: "user:carol", action: "project.read", resource: "project:alpha" };
    expect((await evaluator.check(request)).allowed).toBe(true);
    expect((await evaluator.check(request)).allowed).toBe(true); // warm the cache

    expect(relationships.remove(grant)).toBe(true);

    const after = await evaluator.check(request);
    expect(after.allowed).toBe(false); // the old ALLOW entry is unreachable, not stale
    expect(cache.stats().misses).toBeGreaterThanOrEqual(2);
  });

  it("grants are immediate: a cached DENY is never served after the edge arrives", async () => {
    const { evaluator, relationships } = await cachedSetup();
    const stranger = { subject: "user:carol", action: "project.read", resource: "project:alpha" };
    expect((await evaluator.check(stranger)).allowed).toBe(false);
    expect((await evaluator.check(stranger)).allowed).toBe(false); // warm the cache

    relationships.add({ subject: "user:carol", relation: "viewer", resource: "project:alpha" });

    expect((await evaluator.check(stranger)).allowed).toBe(true);
  });

  it("contexts never share entries (same subject, different mfa)", async () => {
    const setup = acmeSetup({ source: APPROVAL_POLICY });
    await publishAndActivate(setup.policyStore, setup.policy);
    setup.relationships.add({
      subject: "user:carol",
      relation: "approver",
      resource: "invoice:42",
    });
    const cache = new DecisionCache();
    const evaluator = new Evaluator({
      policyStore: setup.policyStore,
      relationshipStore: setup.relationships.asRelationshipStore(),
      decisionCache: cache,
    });
    const request = { subject: "user:carol", action: "invoice.approve", resource: "invoice:42" };
    expect((await evaluator.check({ ...request, context: { mfa: true } })).allowed).toBe(true);
    // If context leaked out of the key, this DENY would be the cached ALLOW.
    expect((await evaluator.check({ ...request, context: { mfa: false } })).allowed).toBe(false);
    expect((await evaluator.check({ ...request, context: { mfa: true } })).allowed).toBe(true);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2 });
  });

  it("subjects never share entries (alice's ALLOW is not bob's answer)", async () => {
    const { evaluator } = await cachedSetup();
    const write = { action: "project.write", resource: "project:alpha" };
    expect((await evaluator.check({ subject: "user:alice", ...write })).allowed).toBe(true);
    expect((await evaluator.check({ subject: "user:bob", ...write })).allowed).toBe(false);
  });

  it("a cached decision cannot be poisoned by the caller it is returned to", async () => {
    const { evaluator, cache } = await cachedSetup();
    const first = await evaluator.check(ALLOWING);
    expect(Object.isFrozen(first)).toBe(true);
    // Mutation must fail (frozen, strict mode) rather than rewrite the entry.
    expect(() => {
      (first as unknown as { allowed: boolean }).allowed = false;
    }).toThrow(TypeError);
    const second = await evaluator.check(ALLOWING);
    expect(second.allowed).toBe(true);
    expect(cache.stats().hits).toBe(1);
  });
});
