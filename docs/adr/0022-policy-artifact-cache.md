# ADR-0022: Version-keyed policy artifact cache

Status: **Accepted** (Phase 7)
Related: ADR-0021 (version-keyed decision cache), ADR-0018 S8 (immutable
content-addressed policy versions), ADR-0019 (policy version pinning).
Design background: `docs/architecture/caching.md` ("Policy cache — Safe;
trivial").

## Context

`Evaluator.check()` resolves the active policy artifact on **every** check —
including every decision-cache hit, where the artifact is needed only for its
version string. On PostgreSQL `getActivePolicy()` is two round-trips (the
deployment pointer, then the artifact row), so a cache hit still pays two
policy round-trips plus the relationship-version read before serving a cached
decision. That is the price of keying correctly (ADR-0021), but one of the
three reads can be almost entirely removed.

Compiled artifacts are immutable and content-addressed (ADR-0018 S8): a
version either holds a complete artifact or none, and republishing identical
content mints a **new** version rather than mutating one. `caching.md` calls
the policy cache "safe; trivial" for exactly this reason — there is no
invalidation question to answer.

## Decision

### 1. An opt-in `PolicyCache` keyed by version

`EvaluatorDependencies.policyCache` takes a `PolicyCache`; the default is no
cache, so behavior is unchanged. Entries are keyed by version alone — the same
discipline as the decision cache's relationship-version segment (ADR-0021 §2):
a superseded version simply stops being looked up. No invalidation logic
exists because none is needed: nothing in a version-keyed entry can become
wrong. TTL and LRU capacity are memory hygiene only.

### 2. The active path reads the pointer, not the artifact

`PolicyStore` gains an **optional** `getActiveVersion()` — the pointer without
the artifact — mirroring the optional-surface discipline of `setActiveVersion`
(S7) and `getRelationshipVersion` (S11): read-only facades keep working, and a
store whose active-policy read is one atomic operation simply omits it. Both
bundled stores (`InMemoryPolicyStore`, `PostgresPolicyStore`) already
implement it, so the optionality costs nothing there.

With a cache configured and the pointer surface present, the active path is:
read the pointer, look up the artifact by version, serve. The first check on a
version costs two reads (pointer, artifact); every later check costs one
(pointer). Without the pointer surface, or with no cache,
`getActivePolicy()` is used unchanged.

### 3. Error identity is preserved

When the pointer is `null` (nothing active), the evaluator delegates to
`getActivePolicy()` rather than fabricating an error, so the store's own typed
error surfaces unchanged (ADR-0018 S9: a missing active pointer is an
infrastructure error, not a `null`). An unknown **pinned** version still
raises `PolicyNotFoundError` (ADR-0019) and is never cached — only
successfully loaded artifacts enter the cache.

### 4. Entries are frozen

`set` freezes the `VersionedPolicy` wrapper (artifacts themselves are already
deep-frozen at compile time), continuing the poisoning defense ADR-0021 §5
established for cached decisions.

## Consequences

- A PostgreSQL decision-cache hit costs one round-trip (the pointer) plus the
  relationship-version read, instead of two policy round-trips.
- Cache hits never re-read the artifact, so large policies (the
  `large-policy` benchmark workload) pay their fetch cost once per version,
  not once per check.
- The pointer surface is a public interface addition, but optional — existing
  `PolicyStore` implementations (including test doubles) compile unchanged.
- Pinned evaluations (ADR-0019) benefit identically: a pinned version is
  fetched once per process.

## Alternatives considered

- **Cache `getActivePolicy()` results keyed by the returned version.**
  Rejected: it still pays both round-trips on every call to _learn_ the
  version — the cache would only ever help if the caller already knew the
  version, which is precisely what the pointer surface provides.
- **Make the pointer surface mandatory.** Rejected: it would break every
  read-only facade and single-query store for a surface only the cache uses,
  violating the optional-surface discipline the store contract already
  establishes (S7, S11).
- **Fold policy loading into the decision cache.** Rejected: decisions cite
  the policy version, so the artifact load must happen _before_ key
  construction; caching it separately keeps each cache's key semantics
  independent and testable.
