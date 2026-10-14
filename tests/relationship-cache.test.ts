import { describe, expect, it } from "vitest";
import {
  Relationship,
  RelationshipQuery,
  RelationshipStore,
  ValidationError,
} from "../packages/core/src/index.js";
import {
  Evaluator,
  InMemoryRelationshipStore,
  RelationshipCache,
} from "../packages/evaluator/src/index.js";
import { ACME_RELATIONSHIPS, parseFixtureLine } from "../examples/acme/fixture.js";
import { acmeSetup, publishAndActivate } from "./helpers.js";

/**
 * Relationship query cache (ADR-0023).
 *
 * The safety claim is the decision cache's (ADR-0021 §2) applied to reads:
 * entries are keyed by query **and** the opaque state version of the check
 * that populated them, so when state moves, the previous generation's rows
 * are unreachable — a cache can never serve a row the current state does not
 * support. TTL/LRU are hygiene only.
 */
describe("RelationshipCache (ADR-0023)", () => {
  const rows: readonly Relationship[] = [
    { subject: { type: "user", id: "a" }, relation: "r", resource: { type: "p", id: "1" } },
  ];

  function double(inner: readonly Relationship[] = rows) {
    let calls = 0;
    const store: RelationshipStore = {
      getRelationships: () => {
        calls += 1;
        return Promise.resolve(inner);
      },
    };
    return { store, calls: () => calls };
  }

  const query: RelationshipQuery = {
    subject: { type: "user", id: "a" },
    relation: "r",
    resource: { type: "p", id: "1" },
  };

  it("serves repeated queries within one generation from the cache", async () => {
    const inner = double();
    const cache = new RelationshipCache(inner.store);
    const first = await cache.query(query, "7");
    const second = await cache.query(query, "7");
    expect(first).toEqual(rows);
    expect(second).toBe(first);
    expect(inner.calls()).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("keys each generation independently: a moved version is a new keyspace", async () => {
    const inner = double();
    const cache = new RelationshipCache(inner.store);
    await cache.query(query, "7");
    await cache.query(query, "7");
    expect(inner.calls()).toBe(1);
    // State moved: generation 8 is a separate keyspace, so the fetch repeats.
    await cache.query(query, "8");
    expect(inner.calls()).toBe(2);
    await cache.query(query, "8");
    expect(inner.calls()).toBe(2);
    // Unreachability of generation 7 is by construction: the evaluator only
    // ever queries with the *current* version, so it never asks for 7 again.
    // The evaluator-level test in this file pins that end-to-end.
  });

  it("freezes cached rows against caller mutation", async () => {
    const inner = double();
    const cache = new RelationshipCache(inner.store);
    const result = await cache.query(query, "7");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(() => {
      (result as Relationship[]).push(rows[0] as Relationship);
    }).toThrow(TypeError);
  });

  it("expires entries after ttlMs, then treats them as a miss", async () => {
    let now = 1000;
    const inner = double();
    const cache = new RelationshipCache(inner.store, { ttlMs: 100, now: () => now });
    await cache.query(query, "7");
    now += 99;
    await cache.query(query, "7");
    expect(inner.calls()).toBe(1);
    now += 1;
    await cache.query(query, "7");
    expect(inner.calls()).toBe(2);
    expect(cache.stats().misses).toBe(2);
  });

  it("evicts least-recently-used entries beyond maxEntries", async () => {
    const inner = double();
    const cache = new RelationshipCache(inner.store, { maxEntries: 2 });
    await cache.query({ ...query, resource: { type: "p", id: "1" } }, "7");
    await cache.query({ ...query, resource: { type: "p", id: "2" } }, "7");
    await cache.query({ ...query, resource: { type: "p", id: "1" } }, "7"); // refresh 1
    await cache.query({ ...query, resource: { type: "p", id: "3" } }, "7"); // evicts 2
    await cache.query({ ...query, resource: { type: "p", id: "2" } }, "7");
    expect(inner.calls()).toBe(4); // 1, 2, 3, then 2 again after eviction
    expect(cache.stats().evictions).toBe(2);
  });

  it("rejects nonsensical bounds instead of silently disabling itself", () => {
    const inner = double();
    expect(() => new RelationshipCache(inner.store, { maxEntries: 0 })).toThrow(ValidationError);
    expect(() => new RelationshipCache(inner.store, { ttlMs: 0 })).toThrow(ValidationError);
  });
});
describe("evaluator relationship loading with the query cache (ADR-0023)", () => {
  /** A versioned store double that counts queries and version reads. */
  function countingStore() {
    const inner = new InMemoryRelationshipStore();
    inner.addAll(
      ACME_RELATIONSHIPS.map((line) => {
        const p = parseFixtureLine(line);
        return { subject: p.subject, relation: p.relation, resource: p.resource };
      }),
    );
    let queries = 0;
    let versionReads = 0;
    const store = {
      getRelationships: (query: RelationshipQuery) => {
        queries += 1;
        return inner.asRelationshipStore().getRelationships(query);
      },
      getRelationshipVersion: () => {
        versionReads += 1;
        return inner.getRelationshipVersion();
      },
    };
    return { store, inner, counts: () => ({ queries, versionReads }) };
  }

  const carolDocA = { subject: "user:carol", action: "document.read", resource: "document:a" };
  const carolDocB = { subject: "user:carol", action: "document.read", resource: "document:b" };

  it("serves sub-traversal queries shared across checks from the cache", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    // Carol has no edges: both documents evaluate the FULL project/org
    // traversal (7 queries each uncached). The project-level probes repeat.
    const cached = countingStore();
    const cachedEvaluator = new Evaluator({
      policyStore,
      relationshipStore: cached.store,
      relationshipCache: {},
    });
    const firstCached = await cachedEvaluator.check(carolDocA);
    const secondCached = await cachedEvaluator.check(carolDocB);

    const plain = countingStore();
    const plainEvaluator = new Evaluator({ policyStore, relationshipStore: plain.store });
    const firstPlain = await plainEvaluator.check(carolDocA);
    const secondPlain = await plainEvaluator.check(carolDocB);

    // 7 (doc A) + 7 (doc B) uncached; cached: 7 + 1 new contains probe.
    expect(plain.counts().queries).toBe(14);
    expect(cached.counts().queries).toBe(8);
    expect(cached.counts().queries).toBeLessThan(plain.counts().queries);
    // Caching reads must not change decisions.
    expect(firstCached).toEqual(firstPlain);
    expect(secondCached).toEqual(secondPlain);
    expect(firstCached.allowed).toBe(false);
  });

  it("a state change refetches: a grant is observed immediately", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const counting = countingStore();
    const evaluator = new Evaluator({
      policyStore,
      relationshipStore: counting.store,
      relationshipCache: {},
    });
    const before = await evaluator.check(carolDocA);
    expect(before.allowed).toBe(false);
    const queriesAfterFirst = counting.counts().queries;

    // Grant the access: the state version moves, so every cached row from the
    // previous generation is unreachable and the check refetches.
    counting.inner.add({
      subject: "user:carol",
      relation: "viewer",
      resource: "project:alpha",
    });
    const after = await evaluator.check(carolDocA);
    expect(after.allowed).toBe(true); // stale DENY is not served
    expect(counting.counts().queries).toBeGreaterThan(queriesAfterFirst);
  });

  it("decisions are identical with and without the cache across a mixed batch", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const requests = [
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      { subject: "user:bob", action: "document.read", resource: "document:b" },
      carolDocA,
      { subject: "user:bob", action: "document.delete", resource: "document:a" },
    ];
    const cached = countingStore();
    const cachedEvaluator = new Evaluator({
      policyStore,
      relationshipStore: cached.store,
      relationshipCache: {},
    });
    const plain = countingStore();
    const plainEvaluator = new Evaluator({ policyStore, relationshipStore: plain.store });
    for (const request of requests) {
      expect(await cachedEvaluator.check(request)).toEqual(await plainEvaluator.check(request));
    }
    expect(cached.counts().queries).toBeLessThan(plain.counts().queries);
  });

  it("batch items share one version read and one generation", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const counting = countingStore();
    const evaluator = new Evaluator({
      policyStore,
      relationshipStore: counting.store,
      relationshipCache: {},
    });
    await evaluator.checkBatch([carolDocA, carolDocB]);
    expect(counting.counts().versionReads).toBe(1);
  });

  it("refuses a query cache when the store cannot report a version (S11)", () => {
    expect(
      () =>
        new Evaluator({
          policyStore: acmeSetup().policyStore,
          relationshipStore: { getRelationships: () => Promise.resolve([]) },
          relationshipCache: {},
        }),
    ).toThrow(ValidationError);
  });
});
