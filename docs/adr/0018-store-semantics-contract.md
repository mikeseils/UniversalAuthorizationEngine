# ADR-0018: Store semantics contract and the conformance suite

Status: **Accepted** (Phase 6)
Related: ADR-0005 (core independence), ADR-0006 (default deny), ADR-0010
(evaluator semantics), ADR-0017 (database decision).

## Context

The engine depends only on two interfaces (`packages/core/src/stores.ts`):

```ts
interface RelationshipStore {
  getRelationships(query: RelationshipQuery): Promise<readonly Relationship[]>;
}

interface PolicyStore {
  getActivePolicy(): Promise<VersionedPolicy>;
  getPolicyVersion(version: string): Promise<VersionedPolicy | null>;
  publishPolicy(policy: PolicySource): Promise<VersionedPolicy>;
}
```

The interfaces are small, which is good — but smallness hides the real risk of
this phase. A persistent backend can satisfy these signatures and still be
**semantically wrong** in ways no test notices:

- returning rows from _after_ a concurrent write, so one check mixes pre- and
  post-mutation state;
- treating an unbound query field as "match nothing" instead of "match all";
- emitting rows in a different order than the in-memory store, silently
  changing explanations and anything derived from them;
- activating a policy on publish, turning a deliberate deployment act into a
  side effect.

None of these are visible by reading the type. All of them are security-relevant.
So the contract must be **normative and executable**, not prose.

## Decision

### 1. `RelationshipStore` semantics (normative)

- **S1 — Unbound means "all".** An omitted `subject` / `relation` / `resource`
  matches every value for that position. An empty result therefore means "no
  such relationship", never "no query was run".
- **S2 — Snapshot consistency within a check.** A single logical evaluation must
  not observe a mutation made partway through it. One decision is computed
  against one coherent state.
- **S3 — Deterministic ordering.** Identical store contents and identical query
  yield identical row order. Explanations embed relationship descriptions, so
  non-deterministic ordering would leak into decision output and break
  reproducibility guarantees elsewhere in the project.
- **S4 — Failures are typed and distinguishable.** An infrastructure failure
  (unreachable, timeout, corrupt row) throws. It is never signalled as an empty
  result, because "no relationships" and "could not read relationships" are
  different security states: the first denies, the second must be
  `AUTHZ_UNAVAILABLE`.
- **S5 — Writes are idempotent.** Adding an existing relationship is a no-op;
  removing a non-existent one succeeds. Networks fail, so every mutation must be
  safe to retry. Retried writes must not duplicate or corrupt state.
- **S6 — Returned rows are frozen** and must not alias mutable internal state.
- **S11 — The state version is an opaque, side-effect-free token.** Any backend
  that can mutate relationships must also report _which_ state it holds, as a
  version token callers compare with `!==` — never parse, order, or
  arithmetically combine. Reading the version must not advance it: a read that
  changed the version would invalidate the very cache entry its own token keys
  (`docs/architecture/caching.md` rule 1). Conversely, a write that actually
  changes state must change the token, while a no-op write (S5 idempotent
  re-add, remove of nothing) must not — token churn on unchanged state evicts
  the whole decision cache on ordinary retry traffic. The token speaks only
  _that_ something changed, never _what_: it is a global invalidation signal,
  so scoped invalidation stays a research problem rather than a hidden,
  unprovable assumption. The version surface is optional on `RelationshipStore`
  (see `VersionedRelationshipStore`): a backend that cannot report its state
  simply cannot back a version-keyed cache, and claiming otherwise would make
  stale-decision serving a silent possibility.

### 2. `PolicyStore` semantics (normative)

- **S7 — Publishing never activates.** `publishPolicy` creates a new immutable
  version. Activation is a separate, explicit act. This preserves the deliberate
  deployment boundary and mitigates policy-rollback / surprise-deployment
  threats (`docs/security/threat-model.md`).
- **S8 — Artifacts are immutable and content-addressed.** A published version's
  `artifact` and `hash` never change; the hash is reproducible from content.
  Republishing identical content therefore mints a **new** version: versions —
  not hashes — are the unit of audit, rollback, and pinning (ADR-0019), so a
  uniqueness constraint on the hash would turn a legitimate republish into a
  constraint violation instead of a new deployment candidate.
- **S9 — Unknown versions return `null`,** and only unknown versions do. A
  missing _active_ pointer is an infrastructure error, not a `null`.
- **S10 — Policy source failures are caller errors.** Malformed source is
  rejected at publish with a typed error and never becomes a stored version.

### 3. The conformance suite is the enforcement mechanism

Prose contracts rot. `tests/store-conformance.test.ts` exposes a shared,
parameterized `describeStoreContract(name, factory)` that **every** store
implementation must pass — the in-memory reference store and each persistent
backend. The in-memory store is not exempt: it is held to the same bar, so it
cannot silently drift into being a second, laxer specification.

A new backend is not "done" until it runs this suite unmodified.

## Consequences

- Correctness for a future store becomes a matter of running tests, not of
  re-deriving intent from prose — which is the entire point of this phase.
- The in-memory store's documented guarantees (`in-memory-relationship-store.ts`)
  are promoted from implementation notes to contract requirements.
- Backends must be able to expose a snapshot scope (S2). For Postgres that is a
  `REPEATABLE READ` transaction; implementations that cannot guarantee it must
  not claim conformance.
- Persistent backends run the same suite, so ADR-0017's decision can be
  re-validated by measurement rather than defended by assertion.
- Persistent backends are validated against a **live** database, not only the
  in-process double. The first live Phase 6 run failed twice on defects the
  double could not express: node-postgres hands back an **array** of results for
  a multi-statement migration file (so `.rows` was `undefined` and every
  migration aborted), and the initial policy schema declared the content `hash`
  `UNIQUE`, contradicting S8. A double can only encode what its author already
  understood, so the recording double stays the unit-level tool and a real
  database remains the acceptance gate.

## Alternatives considered

- **Document only, no suite.** Rejected: unreviewed prose is exactly what let
  silent semantic drift become a class of bug rather than a caught defect.
- **Interface-level test doubles as the contract.** Rejected: a mock encodes what
  the caller _uses_, not what the store must _guarantee_; it cannot catch an
  implementation that disagrees with the reference store.
- **Snapshot isolation at the evaluator level only.** Rejected: it would make
  the evaluator responsible for a storage property, coupling the core to a
  persistence concern and breaking ADR-0005.
