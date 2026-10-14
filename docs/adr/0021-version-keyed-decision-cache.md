# ADR-0021: Version-keyed decision cache

Status: **Accepted** (Phase 7)
Related: ADR-0018 (store semantics contract, S11), ADR-0019 (policy version
pinning), ADR-0006 (default deny), ADR-0016 (SDK design). Design background:
`docs/architecture/caching.md` (binding rules), `docs/security/threat-model.md`
(cache poisoning).

## Context

`docs/architecture/caching.md` sets binding rules for decision caching before
any implementation exists — the phase discipline is "invalidation requirements
first". The hard rule is #1: **cache keys must incorporate authorization state
versions**, not just TTLs, because a stale cached decision is a security
vulnerability (a stale ALLOW after revocation is a breach; a stale DENY is an
availability bug). ADR-0018 S11 then made the relationship-state version a
contract obligation: every mutating backend reports an opaque, side-effect-free
version token, and a token moves exactly when state moves.

What was missing is the component that consumes S11. Without it, each check
costs the full evaluation (~3.67 queries/check on both backends — measured,
`pnpm bench`), and with it a check that repeats a recently computed decision
costs one version read plus a lookup.

The correctness hazard is not "is the cache fast" but "can the cache ever serve
a decision the current state does not support". TTL-only caching cannot answer
that: a one-second TTL still serves one second of stale ALLOWs after a
revocation, and no TTL is both safe for revocation and useful for hit rate.

## Decision

### 1. A version-keyed, opt-in cache inside the evaluator

An optional `DecisionCache` participates in `Evaluator.check()` when supplied
via `EvaluatorDependencies.decisionCache`. The default is **no cache** — the
current behavior is unchanged, and the strong-consistency path
(`caching.md` rule 4) is simply "do not configure a cache" for now; the future
`consistency: "strong"` option (Phase 12/78) will bypass explicitly.

The cache lives in the evaluator layer, not the SDK: the evaluator is the only
layer that already knows the policy version and can read the relationship
version, and a cache that needs its inputs from above it would push
state-version awareness into every embedder.

### 2. The key is the whole safety argument

```
key = subject + action + resource
    + policyVersion          (ADR-0018 S8: immutable, addressable)
    + relationshipVersion    (ADR-0018 S11: opaque token, `!==` comparison)
    + explanationLevel       (levels prune different subtrees, ADR-0011)
    + canonical(context)     (sorted-key JSON; contexts differ ⇒ decisions differ)
```

Invalidation is **deterministic, not heuristic**: when any relationship
changes, the S11 token moves and every entry keyed to the old token becomes
unreachable — it cannot be looked up, because a lookup must first read the
current version, and that read returns the new token. Rule 1 of
`caching.md` is satisfied by construction rather than by tuning.

The relationship version is read **before** evaluation, never after. Reading
first and evaluating second means an entry keyed `v` was computed from state
≥ `v`; reading after would let an entry keyed `v'` (already moved) hold data
from state `< v'`, which is exactly the stale-serve the key is supposed to
prevent. This ordering is safe only because S11 made the version read
side-effect free — a read that advanced the version would invalidate the entry
its own token keys.

The tokens are compared as opaque strings (`!==`), never parsed or ordered
(S11), so the cache never grows an accidental dependency on a backend's
version format.

### 3. What is never cached

- **`reason: "error"` decisions** — an evaluation that could not complete
  reflects a transient condition; caching its fail-closed DENY would extend an
  outage into the cache's TTL window and blur the DENIED-vs-AUTHZ_UNAVAILABLE
  distinction (`failure-modes.md`).
- **Thrown errors** — infrastructure failures reject before any write happens;
  only successfully finalized decisions are stored.
- **`AUTHZ_UNAVAILABLE` outcomes at the SDK layer** — the cache never sees
  them; it sits below the SDK's structural DECISION-vs-UNAVAILABLE split.

Negative caching (plain `policy_deny`) is _safe_ precisely because of the
version key: a denial is unreachable the moment any state changes, which is a
stronger guarantee than `caching.md` rule 3's "bound them tightly" asks of
TTL-based designs. Rule 3 is satisfied by keying, not by skipping denials.

### 4. Bounded memory, TTL as housekeeping — not as invalidation

Entries live in an LRU capped at `maxEntries` and are swept after `ttlMs`.
Both bounds exist for **memory and hygiene** (stale-generation entries from a
long-quiet version are eventually freed even if no read ever touches their
generation again); neither participates in correctness. Correctness rests
entirely on the key. An expired entry causes a miss, never a wrong answer.

### 5. Entries are immutable — cache-poisoning defense

A stored decision is deep-frozen before it is published to the cache and the
frozen object is what callers receive (with the cache configured, every
returned decision is therefore frozen; the field types are already `readonly`).
A caller that mutates a returned decision cannot rewrite what the next hit
serves. Writes come only from `finalize()` on verified evaluation results —
nothing else can insert into the cache — addressing the poisoning rows in the
threat model.

### 6. A cache without a version is a configuration error

If a `DecisionCache` is configured but the relationship store does not expose
`getRelationshipVersion()` (the surface is deliberately optional, ADR-0018
S11), the evaluator **throws at construction** (`ValidationError`). Silently
degrading to an unkeyed or TTL-only cache would implement exactly the design
`caching.md` forbids, and doing it silently is worse than not shipping a cache.

### 7. Observability

The cache reports `hits`, `misses`, `evictions`, and `size`, and emits
`cache:hit` / `cache:miss` observer stages. A cache you cannot measure is a
cache you cannot tune or audit.

## Consequences

- A repeated check against unchanged state costs one version read instead of
  a full traversal; `pnpm bench` gains a cache scenario (hit rate, p95) to
  quantify it on both backends.
- Global invalidation is the deliberate trade: any relationship change
  unreachable-izes _all_ entries. This is safe and simple; per-edge scoped
  invalidation (dependency tracking, `caching.md` rule 2, roadmap Phase 47)
  remains a research problem, deliberately deferred rather than faked.
- Every `check()` now performs a version read when a cache is configured —
  on Postgres that is one round-trip, which hits still win against, but
  uncached-path throughput pays it. This is the price of keying correctly.
- Batch checks read the version once per item (they reuse `check()`); a
  per-batch version read is a known follow-up optimization, not a correctness
  concern.
- With the cache configured, decisions are frozen objects. Callers that
  mutate decisions in place (contractually forbidden by the `readonly` types)
  would now fail loudly under strict mode instead of silently.

## Alternatives considered

- **TTL-only cache.** Rejected by `caching.md` rule 1: any TTL is
  simultaneously too long (stale ALLOW after revocation) and too short (hit
  rate collapses), and it makes the security property a tuning parameter.
- **Cache at the SDK layer.** Rejected: the SDK would have to re-derive policy
  and relationship versions from decisions, duplicating knowledge the
  evaluator already has and creating two places where key construction could
  drift.
- **Dependency-graph invalidation now (rule 2).** Deferred, not rejected: it
  needs the relationship→decision dependency index from Phase 47. Version
  keying is strictly conservative — it invalidates at least everything the
  dependency graph would — so shipping it first loses no correctness, only
  hit rate under heavy write traffic.
- **Cache only ALLOWs.** Rejected: with version-keyed entries a denial is as
  reproducible as a grant, and skipping denials would leave the
  highest-volume read pattern (ordinary not-permitted traffic) uncached for a
  safety property the key already provides.
- **Serve stale while refreshing (stale-while-revalidate).** Rejected
  outright: "serve stale" for authorization decisions is the vulnerability
  class this engine exists to prevent; a refresh race must never widen the
  window in which a revoked ALLOW is answerable.
