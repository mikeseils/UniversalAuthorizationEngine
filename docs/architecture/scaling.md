# Scaling

Status: **Measured where measured, unclaimed elsewhere.** The evaluator
posture below was a design direction through Phase 6; Phase 7 measured the
steady-state decision path (`pnpm bench`, values in
`docs/development/roadmap.md`): 3.67 queries/check uncached across all
baseline workloads and both backends, 0.00 warm with the decision cache, and
0.32–0.94 distinct-stream with the relationship query cache. What Phase 7 did
_not_ measure — list authorization, distributed graphs, multi-region
behavior — stays unclaimed.

## The evaluator's scaling posture

The decision path is CPU-bound graph traversal over interface-supplied state.
Scaling therefore decomposes into:

1. **Scale reads horizontally** — decision nodes are stateless given a policy
   artifact + relationship snapshot; add nodes freely.
2. **Bound work per request** — maximum traversal depth/fan-out, batch size
   limits, context size limits; pathological requests degrade to DENY +
   explanation marker, not OOM/timeout-based ALLOW.
3. **Optimize the hot path** — compiled policy (precomputed evaluation plans),
   relationship indexes, caching per `caching.md`.

## The list problem (architecturally anticipated)

```
GET /documents   →  authorize all rows?
```

Naive per-row `check()` is unacceptable at scale. The long-term answer is
list-aware authorization (`authorize.list(...)` returning resource IDs or an
executable predicate) and database-aware authorization (generating
`WHERE ...` constraints). Architecturally anticipated from the start;
implemented in later phases.

## Distributed graph (Phase 11-class problems, deferred)

At 10M users / 100M resources / 1B relationships, authorization is not a
normal relational lookup. The eventual architecture combines:

- incremental graph updates + relationship indexing
- aggressive, dependency-aware caching (`caching.md`)
- bounded traversal, consistency controls, efficient invalidation
- snapshotting

with a change stream driving cache invalidation and index updates.

## Multi-region (deferred)

Policies replicate globally as immutable versions; relationships replicate
according to customer consistency/data-residency requirements; local nodes
answer (see `control-plane-data-plane.md`).

## What we will not do

- Invent performance numbers before measuring.
- Add distributed infrastructure before the single-node evaluator is proven
  correct, fast, and explainable.
