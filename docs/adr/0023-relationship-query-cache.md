# ADR-0023: Generation-keyed relationship query cache

Status: **Accepted** (Phase 7)
Related: ADR-0021 (version-keyed decision cache), ADR-0018 S11 (opaque
state-version surface), ADR-0010 (evaluator semantics). Design background:
`docs/architecture/caching.md` ("Relationship cache — safe for immutable
snapshots per relationship version; traversal caches must be keyed by the
same state versions as decisions").

## Context

The decision cache (ADR-0021) collapses whole checks: a repeated
(subject, action, resource) against unchanged state costs one version read.
What it does not help is a **burst of distinct checks that share
sub-traversals** — fifty documents in one project, fifty members of one
group. Each of those checks re-probes the same project-level edges, because
the decision cache only fires on an identical _decision_ key.

`caching.md` permits a relationship cache "for immutable snapshots per
relationship version" and requires traversal caches to be "keyed by the
same state versions as decisions". ADR-0018 S11 then made that keying
possible for every backend.

## Decision

### 1. An opt-in query cache keyed by (query, generation)

`EvaluatorDependencies.relationshipCache` takes **options** (not an
instance): the evaluator constructs the `RelationshipCache` around the store
it was given, so the version surface it keys on and the store it reads
cannot diverge. The constructed cache is exposed as
`evaluator.relationshipCache` for stats.

Entries are keyed by the canonical query **and the opaque state version
(generation) of the check that populated them** — the ADR-0021 §2 discipline
applied to reads. The safety argument is identical: a lookup can only
happen with the _current_ version (the evaluator reads it before
evaluation), so when state moves, the previous generation's entries are
unreachable — never served. Unreachability is by construction, not by
eviction: the evaluator simply never asks for an old generation again.

### 2. No interface change to the store

`EvalState.store` is the evaluator's single query choke point
(`evalRelation`, `evalIndirect`). The cache is interposed there as a
per-check view (`storeFor(version)`), so traversal code, limits, cycle
detection, and explanation generation are untouched — the cached store is a
`RelationshipStore` like any other. This is why the relationship cache did
not need the interface surgery a store-decorator design would have
required.

### 3. Rows are frozen

Cached rows are deep-frozen before publication (array and every row),
continuing the ADR-0021 §5 poisoning defense: a caller that mutated a
cached row could rewrite what later hits serve. S6 already forbids aliasing
mutable internal state; freezing makes the cache side of that contract
enforceable.

### 4. A cache without a version is a construction error

Same rule as the decision cache: a `relationshipCache` configured against
a store without `getRelationshipVersion()` throws at construction. A
query cache that cannot be keyed by state is exactly what `caching.md`
forbids.

### 5. TTL and LRU are hygiene

Capacity and expiry free memory of generations that fell out of use; an
expired entry causes a miss, never a wrong answer.

## Consequences

- **Per-burst query reduction.** Distinct checks that share sub-traversals
  read each shared edge once per generation (`tests/relationship-cache.test.ts`
  asserts 14 uncached probes fall to 8 cached ones, with identical answers).
  The first check in a new generation pays the version read plus full probes;
  every later check reuses them while the version is unchanged.
- **Grants are visible immediately.** Bumping the store version makes old
  entries unreachable in the same way a crash would; no invalidation hook,
  no revalidation, no lag. S11 tests pin the refusal path: a store without
  `getRelationshipVersion()` cannot construct the cache at all.
- **No store interface change.** The cache lives in the evaluator behind a
  per-check view, so custom `RelationshipStore` implementations keep working
  unchanged — they only gain an optional `getRelationshipVersion()`
  (ADR-0018 S11) to become cacheable.
- **Stats stay observable.** `evaluator.relationshipCache` exposes hit, miss,
  and size counters (the shared `EntryMap` statistics) so bench and tests can
  prove the reduction instead of assuming it.

## Alternatives considered

- **Decorator around the store.** Interposing a caching `RelationshipStore`
  looked natural, but the evaluator passes the store through several layers
  (limits, explanation, instruction collection) and needs the version read
  once per check, not once per query; a decorator would have needed the
  version threaded through the `RelationshipStore` interface itself — a
  breaking change every backend pays — and would cache without knowing the
  generation the check was evaluated under. The `storeFor(version)` view
  keeps both coupled at one call site.
- **Process-wide (module-level) cache.** A shared cache across evaluator
  instances would tie lifetimes to the process, leak generations nobody will
  ask for again, and make eviction and stats ambiguous under concurrent
  evaluators. Per-evaluator construction keeps ownership and observability
  local.
- **TTL as invalidation.** Treating expiry as the staleness mechanism would
  reintroduce the bug ADR-0021 forbids: serving pre-grant answers for up to
  the TTL window. Expiry here is memory hygiene only; correctness comes from
  the generation key.
- **Keys without the generation.** Query-only keys would be faster to compute
  but unsafe: after a grant, the very same query returns different rows, and
  a cached pre-grant result would deny what the store now allows. The opaque
  version in the key is what makes the cache a pure speedup.
