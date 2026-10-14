import { describe, expect, it } from "vitest";
import { RelationshipQuery } from "../packages/core/src/index.js";
import {
  DecisionCache,
  Evaluator,
  InMemoryRelationshipStore,
} from "../packages/evaluator/src/index.js";
import { ACME_RELATIONSHIPS, parseFixtureLine } from "../examples/acme/fixture.js";
import { acmeSetup, check, publishAndActivate } from "./helpers.js";

describe("batch checks", () => {
  it("return decisions identical to individual checks", async () => {
    const { evaluator, policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const requests = [
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      { subject: "user:bob", action: "document.delete", resource: "document:a" },
      { subject: "user:carol", action: "project.read", resource: "project:alpha" },
    ] as const;
    const batch = await evaluator.checkBatch(requests.map((r) => ({ ...r })));
    const individual = [];
    for (const r of requests)
      individual.push(await check(evaluator, r.subject, r.action, r.resource));
    expect(batch).toEqual(individual);
  });

  it("a denial in the batch does not poison siblings", async () => {
    const { evaluator, policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const decisions = await evaluator.checkBatch([
      { subject: "user:carol", action: "document.read", resource: "document:a" }, // deny
      { subject: "user:alice", action: "document.read", resource: "document:a" }, // allow
    ]);
    expect(decisions[0]?.allowed).toBe(false);
    expect(decisions[1]?.allowed).toBe(true);
  });
});

describe("batch checks with the decision cache (ADR-0021)", () => {
  /** A versioned store double that counts version reads and queries. */
  function countingStore() {
    const inner = new InMemoryRelationshipStore();
    inner.addAll(
      ACME_RELATIONSHIPS.map((line) => {
        const p = parseFixtureLine(line);
        return { subject: p.subject, relation: p.relation, resource: p.resource };
      }),
    );
    let versionReads = 0;
    let queries = 0;
    return {
      store: {
        getRelationships: (query: RelationshipQuery) => {
          queries += 1;
          return inner.asRelationshipStore().getRelationships(query);
        },
        getRelationshipVersion: () => {
          versionReads += 1;
          return inner.getRelationshipVersion();
        },
      },
      counts: () => ({ versionReads, queries }),
    };
  }

  it("reads the relationship version once per batch, not once per item", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const counting = countingStore();
    const cache = new DecisionCache();
    const evaluator = new Evaluator({
      policyStore,
      relationshipStore: counting.store,
      decisionCache: cache,
    });
    const decisions = await evaluator.checkBatch([
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      { subject: "user:bob", action: "document.read", resource: "document:b" },
    ]);
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true]);
    // One read for the whole batch; the second item is a decision-cache hit.
    expect(counting.counts().versionReads).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2 });
  });

  it("an empty batch reads no version", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const counting = countingStore();
    const evaluator = new Evaluator({
      policyStore,
      relationshipStore: counting.store,
      decisionCache: new DecisionCache(),
    });
    expect(await evaluator.checkBatch([])).toEqual([]);
    expect(counting.counts().versionReads).toBe(0);
  });

  it("without a cache, no version reads happen at all", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const counting = countingStore();
    const evaluator = new Evaluator({ policyStore, relationshipStore: counting.store });
    await evaluator.checkBatch([
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      { subject: "user:bob", action: "document.read", resource: "document:b" },
    ]);
    expect(counting.counts().versionReads).toBe(0);
  });

  it("batch decisions match individual checks keyed per item", async () => {
    const { policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const counting = countingStore();
    const cache = new DecisionCache();
    const evaluator = new Evaluator({
      policyStore,
      relationshipStore: counting.store,
      decisionCache: cache,
    });
    const request = { subject: "user:alice", action: "document.read", resource: "document:a" };
    const [batched] = await evaluator.checkBatch([request]);
    const individual = await evaluator.check(request);
    expect(batched).toEqual(individual);
    // The batch read and the individual read keyed the same (version, request)
    // pair, so the individual check is served from the batch-populated entry.
    expect(cache.stats().hits).toBe(1);
  });
});
