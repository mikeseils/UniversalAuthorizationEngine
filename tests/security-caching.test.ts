import { describe, expect, it } from "vitest";
import { RelationshipQuery, VersionedRelationshipStore } from "../packages/core/src/index.js";
import { DecisionCache, Evaluator, PolicyCache } from "../packages/evaluator/src/index.js";
import { StructuredPolicy, anyOf, relationRef } from "../packages/policy/src/index.js";
import { ACME_POLICY, acmeSetup, check, publishAndActivate } from "./helpers.js";

/**
 * Caching security invariants — threat-model rows 3-5 with **every** cache
 * configured at once (decision + policy + relationship, ADR-0021/0022/0023).
 *
 * The per-cache suites pin each cache's mechanics; this suite pins the
 * configuration production actually runs, where all three caches must agree
 * about which state is current. Every guarantee rests on the same mechanism:
 * entries — decisions, artifacts, and relationship rows alike — are keyed by
 * opaque state versions, so a move of either version makes the previous
 * generation unreachable rather than stale (docs/architecture/caching.md
 * rule 1; TTL/LRU are memory hygiene only).
 */
describe("caching security invariants with all caches configured (threat-model rows 3-5)", () => {
  /** Acme + every cache enabled — the production configuration under test. */
  async function cachedSetup() {
    const { policyStore, relationships } = acmeSetup();
    const decisionCache = new DecisionCache();
    const policyCache = new PolicyCache();
    const evaluator = new Evaluator({
      policyStore,
      relationshipStore: relationships.asRelationshipStore(),
      decisionCache,
      policyCache,
      relationshipCache: {},
    });
    await publishAndActivate(policyStore);
    return { policyStore, relationships, evaluator, decisionCache, policyCache };
  }

  it("revocation is immediate with every cache warm (row 4)", async () => {
    const { relationships, evaluator } = await cachedSetup();
    relationships.add({ subject: "user:carol", relation: "viewer", resource: "project:alpha" });
    const docA = { subject: "user:carol", action: "document.read", resource: "document:a" };
    // Grant is visible (relationship-cache test) — and repeating the check
    // warms every cache on the ALLOW: decision entry, policy artifact, rows.
    expect((await evaluator.check(docA)).allowed).toBe(true);
    expect((await evaluator.check(docA)).allowed).toBe(true);
    // Revoke. The relationship version moves, so the decision entry keyed to
    // the old generation is unreachable and the rows are re-read: a stale
    // ALLOW — the breach caching.md rule 3 calls out — is impossible.
    relationships.remove({ subject: "user:carol", relation: "viewer", resource: "project:alpha" });
    expect((await evaluator.check(docA)).allowed).toBe(false);
    // Unrelated state did not change: alice keeps her fixture access, and
    // carol's new DENY is itself now served from the cache.
    expect((await check(evaluator, "user:alice", "document.read", "document:a")).allowed).toBe(
      true,
    );
    expect((await evaluator.check(docA)).allowed).toBe(false);
  });

  it("a republished policy is observed immediately, warm caches notwithstanding (row 4)", async () => {
    const { policyStore, evaluator } = await cachedSetup();
    const write = { subject: "user:bob", action: "project.write", resource: "project:alpha" };
    // v1: project.write = editor or owner; bob is only a viewer, so this DENY
    // is cached across all three caches by repeating it.
    expect((await evaluator.check(write)).allowed).toBe(false);
    expect((await evaluator.check(write)).allowed).toBe(false);
    // v2 widens write to include viewers. The active pointer moves: the v1
    // decision entry (policy-version segment), the v1 artifact, and the v1
    // rows are all addressed to the superseded generation where they remain.
    const base = ACME_POLICY.definitions.project;
    if (base === undefined) throw new Error("ACME fixture: project definition missing");
    const v2: StructuredPolicy = {
      definitions: {
        ...ACME_POLICY.definitions,
        project: {
          ...base,
          permissions: {
            ...base.permissions,
            write: anyOf(relationRef("editor"), relationRef("owner"), relationRef("viewer")),
          },
        },
      },
    };
    await publishAndActivate(policyStore, { source: v2 });
    expect((await evaluator.check(write)).allowed).toBe(true);
    // The new ALLOW caches under v2 like any other decision.
    expect((await evaluator.check(write)).allowed).toBe(true);
  });

  it("warm cache entries never bridge tenants (rows 3 and 5)", async () => {
    const { relationships, evaluator } = await cachedSetup();
    // Beta tenant: carol owns Beta's project, identically shaped to Acme's.
    relationships.add({ subject: "user:carol", relation: "member", resource: "organization:beta" });
    relationships.add({ subject: "organization:beta", relation: "owns", resource: "project:beta" });
    relationships.add({ subject: "user:carol", relation: "owner", resource: "project:beta" });
    // Warm the Beta answers into every cache: decisions keyed by resource,
    // rows keyed by query, artifacts shared (policy is not tenant state).
    expect((await check(evaluator, "user:carol", "project.read", "project:beta")).allowed).toBe(
      true,
    );
    expect((await check(evaluator, "user:carol", "project.read", "project:beta")).allowed).toBe(
      true,
    );
    // The identical shape in Acme must stay DENY — cached Beta rows and
    // decisions are addressed by subject and resource, so nothing warmed for
    // project:beta can be served for project:alpha.
    expect((await check(evaluator, "user:carol", "project.read", "project:alpha")).allowed).toBe(
      false,
    );
    expect((await check(evaluator, "user:carol", "project.read", "project:alpha")).allowed).toBe(
      false,
    );
    // And Acme's own warm answers are unaffected by carol's Beta entries.
    expect((await check(evaluator, "user:alice", "project.read", "project:alpha")).allowed).toBe(
      true,
    );
  });

  it("callers cannot poison any cache through what they are handed (row 5)", async () => {
    const { evaluator, decisionCache } = await cachedSetup();
    const request = { subject: "user:alice", action: "document.read", resource: "document:a" };
    const first = await evaluator.check(request);
    expect(first.allowed).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    // The cache serves the same frozen entry to the next caller — mutation
    // throws (strict mode) instead of rewriting what later lookups return.
    const second = await evaluator.check(request);
    expect(second).toBe(first);
    expect(() => {
      (first as unknown as { allowed: boolean }).allowed = false;
    }).toThrow(TypeError);
    // Same defense for the debug-level entry: the explanation payload is part
    // of the frozen decision, not an escape hatch around the poisoning rule.
    const explained = await evaluator.check(request, { explanation: "debug" });
    expect(Object.isFrozen(explained.explanation)).toBe(true);
    expect(() => {
      Object.assign(explained.explanation as object, { tampered: true });
    }).toThrow(TypeError);
    expect((await evaluator.check(request)).allowed).toBe(true);
    // Two cache serves: the repeat of the plain check and the final re-check.
    // (The debug-level entry is its own keyspace and was only requested once.)
    expect(decisionCache.stats().hits).toBe(2);
  });

  it("a transient store failure is never cached: recovery is immediate (rows 4 and 5)", async () => {
    const { policyStore, relationships } = acmeSetup();
    const inner = relationships.asRelationshipStore();
    let failures = 0;
    const flaky: VersionedRelationshipStore = {
      getRelationships: (query: RelationshipQuery) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("relationship store down"));
        }
        return inner.getRelationships(query);
      },
      getRelationshipVersion: () => inner.getRelationshipVersion(),
    };
    const decisionCache = new DecisionCache();
    const evaluator = new Evaluator({
      policyStore,
      relationshipStore: flaky,
      decisionCache,
      policyCache: new PolicyCache(),
      relationshipCache: {},
    });
    await publishAndActivate(policyStore);
    // Fail closed: the outage surfaces as a typed error, never as a DENY
    // decision — and ADR-0021 §3 keeps error decisions out of the cache.
    failures = 1;
    await expect(
      evaluator.check({ subject: "user:alice", action: "document.read", resource: "document:a" }),
    ).rejects.toThrow(/relationship store down/);
    expect(decisionCache.stats().size).toBe(0);
    // Nothing was poisoned: the very next check against unchanged state
    // succeeds, and the one after that is a cache hit — one evaluation, no
    // lingering effect from the failed attempt.
    expect((await check(evaluator, "user:alice", "document.read", "document:a")).allowed).toBe(
      true,
    );
    expect((await check(evaluator, "user:alice", "document.read", "document:a")).allowed).toBe(
      true,
    );
    expect(decisionCache.stats()).toMatchObject({ hits: 1, misses: 2, size: 1 });
  });
});
