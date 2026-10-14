import { describe, expect, it } from "vitest";
import {
  ActivatablePolicyStore,
  PolicyNotFoundError,
  PolicySource,
  ValidationError,
  VersionedPolicy,
} from "../packages/core/src/index.js";
import { DecisionCache, Evaluator, PolicyCache } from "../packages/evaluator/src/index.js";
import { InMemoryPolicyStore, PolicyStoreError } from "../packages/policy/src/index.js";
import { acmeSetup, publishAndActivate } from "./helpers.js";

/**
 * Policy artifact cache (ADR-0022).
 *
 * The safety claim is structural, like the decision cache's: entries are
 * keyed by version and artifacts are immutable (ADR-0018 S8), so no entry can
 * ever become wrong — TTL/LRU are memory hygiene only. These tests pin the
 * mechanics and the store-call reductions they exist for.
 */
describe("PolicyCache (ADR-0022)", () => {
  const policy = (version: string): VersionedPolicy => ({
    version,
    hash: "h" + version,
    artifact: {},
  });

  it("stores and retrieves artifacts by version", () => {
    const cache = new PolicyCache();
    expect(cache.get("1")).toBeUndefined();
    cache.set("1", policy("1"));
    expect(cache.get("1")?.version).toBe("1");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("expires entries after ttlMs, then treats them as a miss", () => {
    let now = 1000;
    const cache = new PolicyCache({ ttlMs: 100, now: () => now });
    cache.set("1", policy("1"));
    now += 99;
    expect(cache.get("1")).toBeDefined();
    now += 1;
    expect(cache.get("1")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it("evicts least-recently-used entries beyond maxEntries", () => {
    const cache = new PolicyCache({ maxEntries: 2 });
    cache.set("1", policy("1"));
    cache.set("2", policy("2"));
    expect(cache.get("1")).toBeDefined(); // refresh 1: 2 is now least recent
    cache.set("3", policy("3"));
    expect(cache.get("2")).toBeUndefined();
    expect(cache.get("1")).toBeDefined();
    expect(cache.get("3")).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("rejects nonsensical bounds instead of silently disabling itself", () => {
    expect(() => new PolicyCache({ maxEntries: 0 })).toThrow(ValidationError);
    expect(() => new PolicyCache({ ttlMs: 0 })).toThrow(ValidationError);
  });
});
describe("evaluator policy loading with the policy cache (ADR-0022)", () => {
  /** A policy store that counts which read surfaces are exercised. */
  function countingPolicyStore() {
    const inner = new InMemoryPolicyStore();
    const calls = { getActivePolicy: 0, getPolicyVersion: 0, getActiveVersion: 0 };
    const store: ActivatablePolicyStore = {
      getActivePolicy: () => {
        calls.getActivePolicy += 1;
        return inner.getActivePolicy();
      },
      getPolicyVersion: (version: string) => {
        calls.getPolicyVersion += 1;
        return inner.getPolicyVersion(version);
      },
      getActiveVersion: () => {
        calls.getActiveVersion += 1;
        return Promise.resolve(inner.getActiveVersion());
      },
      publishPolicy: (source: PolicySource) => inner.publishPolicy(source),
      setActiveVersion: (version: string) => {
        inner.setActiveVersion(version);
      },
    };
    return { store, calls, inner };
  }

  const request = { subject: "user:alice", action: "document.read", resource: "document:a" };

  it("serves the active artifact from the cache on the second check", async () => {
    const counting = countingPolicyStore();
    await publishAndActivate(counting.store);
    const evaluator = new Evaluator({
      policyStore: counting.store,
      relationshipStore: acmeSetup().relationships.asRelationshipStore(),
      policyCache: new PolicyCache(),
    });
    await evaluator.check(request);
    await evaluator.check(request);
    // The artifact is fetched once; only the pointer is read per check.
    expect(counting.calls.getPolicyVersion).toBe(1);
    expect(counting.calls.getActiveVersion).toBe(2);
  });

  it("a store without the pointer surface falls back to getActivePolicy", async () => {
    const counting = countingPolicyStore();
    await publishAndActivate(counting.store);
    // Strip the optional pointer surface: only the atomic active read remains.
    const withoutPointer: ActivatablePolicyStore = {
      getActivePolicy: () => counting.store.getActivePolicy(),
      getPolicyVersion: (version: string) => counting.store.getPolicyVersion(version),
      publishPolicy: (source: PolicySource) => counting.store.publishPolicy(source),
      setActiveVersion: async (version: string) => {
        await counting.store.setActiveVersion(version);
      },
    };
    const evaluator = new Evaluator({
      policyStore: withoutPointer,
      relationshipStore: acmeSetup().relationships.asRelationshipStore(),
      policyCache: new PolicyCache(),
    });
    await evaluator.check(request);
    await evaluator.check(request);
    expect(counting.calls.getActivePolicy).toBe(2);
    expect(counting.calls.getPolicyVersion).toBe(0);
  });

  it("republishing mints a new version and the cache refetches", async () => {
    const counting = countingPolicyStore();
    const first = await publishAndActivate(counting.store);
    const evaluator = new Evaluator({
      policyStore: counting.store,
      relationshipStore: acmeSetup().relationships.asRelationshipStore(),
      policyCache: new PolicyCache(),
    });
    const before = await evaluator.check(request);
    // S8: republishing identical content mints a NEW version.
    const second = await publishAndActivate(counting.store);
    expect(second).not.toBe(first);
    const after = await evaluator.check(request);
    expect(after.policyVersion).toBe(second);
    expect(after.policyVersion).not.toBe(before.policyVersion);
    // One fetch per version — the new version is a cache miss, not a stale hit.
    expect(counting.calls.getPolicyVersion).toBe(2);
  });

  it("pinned versions are cached like active ones", async () => {
    const counting = countingPolicyStore();
    const version = await publishAndActivate(counting.store);
    const evaluator = new Evaluator({
      policyStore: counting.store,
      relationshipStore: acmeSetup().relationships.asRelationshipStore(),
      policyCache: new PolicyCache(),
    });
    await evaluator.check(request, { policyVersion: version });
    await evaluator.check(request, { policyVersion: version });
    expect(counting.calls.getPolicyVersion).toBe(1);
  });

  it("an unknown pinned version throws and is not cached", async () => {
    const counting = countingPolicyStore();
    await publishAndActivate(counting.store);
    const evaluator = new Evaluator({
      policyStore: counting.store,
      relationshipStore: acmeSetup().relationships.asRelationshipStore(),
      policyCache: new PolicyCache(),
    });
    await expect(evaluator.check(request, { policyVersion: "nope" })).rejects.toThrow(
      PolicyNotFoundError,
    );
    await expect(evaluator.check(request, { policyVersion: "nope" })).rejects.toThrow(
      PolicyNotFoundError,
    );
    expect(counting.calls.getPolicyVersion).toBe(2);
  });

  it("no active policy surfaces the store's own typed error", async () => {
    const counting = countingPolicyStore();
    // Nothing published or activated.
    const evaluator = new Evaluator({
      policyStore: counting.store,
      relationshipStore: acmeSetup().relationships.asRelationshipStore(),
      policyCache: new PolicyCache(),
    });
    await expect(evaluator.check(request)).rejects.toThrow(PolicyStoreError);
    // The pointer was consulted, then the store produced its authentic error.
    expect(counting.calls.getActiveVersion).toBe(1);
    expect(counting.calls.getActivePolicy).toBe(1);
  });

  it("decision-cache hits do not refetch the artifact", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const counting = countingPolicyStore();
    await publishAndActivate(counting.store);
    const evaluator = new Evaluator({
      policyStore: counting.store,
      relationshipStore: setup.relationships.asRelationshipStore(),
      decisionCache: new DecisionCache(),
      policyCache: new PolicyCache(),
    });
    await evaluator.check(request);
    await evaluator.check(request); // decision-cache hit
    // The artifact was fetched exactly once, on the first check.
    expect(counting.calls.getPolicyVersion).toBe(1);
  });
});
