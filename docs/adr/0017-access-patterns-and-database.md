# ADR-0017: Access patterns and the database decision

Status: **Accepted** (Phase 6)
Supersedes: nothing. Amends `docs/architecture/storage.md` ("Likely first
persistent backend"), which anticipated this decision; the reasoning is now
recorded with evidence rather than assumption.

## Context

The roadmap makes the Phase 6 database choice conditional on _benchmarked and
documented_ access patterns:

> Database choice **after** access patterns are benchmarked and documented
> (Postgres is the likely first candidate; no custom graph DB until proven
> necessary). — `docs/development/roadmap.md`

Choosing a store from intuition is exactly the kind of unexamined assumption
this project rejects. So the first Phase 6 deliverable was measurement.

## Method

`packages/evaluator/src/store-metrics.ts` adds `InstrumentedRelationshipStore`,
a transparent `RelationshipStore` wrapper that records, per query shape, the call
count, result count, latency, and result-set size distribution. It delegates
reads verbatim — no caching, filtering, or reordering — so measured behaviour is
the evaluator's real behaviour, and the evaluator stays side-effect free
(ADR-0005, ADR-0010).

`scripts/bench.mjs` (`pnpm bench`) builds synthetic org → project → document
graphs and drives `document.read` checks through the real evaluator and a real
policy authored in the policy language. Three workloads: 176, 1,152, and 1,632
relationships.

## Measured results

Node 18.14.2, in-memory reference store, after a 50-check warmup:

| Workload    | Relationships | Checks | Decisions   | Queries/check | Check p95 |
| ----------- | ------------- | ------ | ----------- | ------------- | --------- |
| small       | 176           | 400    | 400 allow   | 3.67          | 0.052 ms  |
| medium      | 1,152         | 1,200  | 1,200 allow | 3.67          | 0.130 ms  |
| deep-fanout | 1,632         | 1,600  | 1,600 allow | 3.67          | 0.146 ms  |

Query shape distribution (identical across all three workloads):

| Query shape                 | Share | Result size (mean / p95 / max) | Issued by                                 |
| --------------------------- | ----- | ------------------------------ | ----------------------------------------- |
| `subject+relation+resource` | 63.6% | 0.43 / 1 / 1                   | direct edge probe (`evalRelation`)        |
| `resource+relation`         | 36.4% | 1.00 / 1 / 1                   | reverse `indirect` traversal              |
| `subject+relation`          | 0%    | —                              | forward traversal (unused by this policy) |
| `unbound`                   | 0%    | —                              | never issued                              |

## Findings

**1. Fan-out is low and bounded.** ~3.67 queries per check, and critically the
count is **invariant across a 9x relationship growth** (176 → 1,632). Query cost
is a function of _policy shape_ (permission operands × traversal depth), not
graph size. This is the single most important finding: a store must not be
selected for "it scales with graph size", because the query count does not grow
with it.

**2. Every query is highly selective.** Maximum result set is **1** row in all
workloads; p95 is 1. These are point-lookup probes, not range scans. A
`UNIQUE(subject_type, subject_id, relation, resource_type, resource_id)`
constraint plus two composite indexes serves them directly; no index type beyond
a B-tree is needed.

**3. Only two shapes are used, and they map to two indexes.** The evaluator
issues at most three shapes, all fully-bound on the leading columns of one of
the two access directions (`subject_*` or `resource_*`). Both map to a single
composite index scan.

**4. Latency grew ~3x from small to medium, but not from query count.** The
increase is attributable to the in-memory store's **linear scan** over the edge
map (`O(n)` per query, `in-memory-relationship-store.ts:57`), not to evaluation
work — the query count is constant. An indexed store replaces the scan with a
B-tree descent, which is precisely the cost model that makes the store choice
favourable.

## Decision

**PostgreSQL, via a hand-written SQL data-access layer. No ORM, no graph
database.**

Justified by the evidence:

- Findings 2 and 3 show the workload is a set of small, selective, index-covered
  point lookups — the shape relational engines are optimized for.
- Finding 4 identifies the current bottleneck as an unindexed scan, which is the
  problem an index solves directly. Postgres is also the _cheapest_ way to test
  that hypothesis: a graph database would add operational cost without first
  demonstrating a graph-shaped problem.
- Finding 1 means there is no observed evidence of the "super-linear graph
  traversal" characteristic that would justify a specialized store. Per
  `storage.md`, that must be demonstrated by real workloads first.

The in-memory store remains the **reference implementation** of the store
semantics, and the conformance suite (ADR-0018) holds every backend to it.

## Consequences

- Schema: two composite indexes on the subject and resource access directions;
  the primary key doubles as the idempotency guarantee (ADR-0018).
- The `pg` driver is confined to `packages/persistence`; the core keeps zero
  runtime dependencies (ADR-0005).
- The same `scripts/bench.mjs` harness runs against the Postgres store so the
  two are directly comparable — that comparison, not this ADR, is the evidence
  that the decision was right.
- **Reversal triggers** (recorded so the decision is falsifiable, not
  dogmatic): measured per-check latency dominated by index descent on graphs
  above ~10^8 relationships; a need for multi-hop shortest-path queries the
  evaluator does not issue; or a demonstrated need for subgraph isolation that
  row-level filtering cannot express.

## Notes

This ADR contains **no performance numbers for any persistent store** — none had
been measured when it was written. Inventing them would violate the project's
evidence rule. Numbers appear here only when a harness produced them.
