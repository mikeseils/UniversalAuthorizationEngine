# Storage

Status: **Implemented (Phase 6)**. Interfaces first, PostgreSQL backend second.
The in-memory stores remain the **reference implementation** of the semantics,
and every backend is held to the same executable contract (ADR-0018).

## RelationshipStore

```ts
interface RelationshipStore {
  getRelationships(query: RelationshipQuery): Promise<Relationship[]>;
}
```

Responsibilities: retrieve relationships matching subject/relation/resource
filters (any field may be unbound, e.g. "all relations from `user:alice`" or
"all subjects related to `document:456`").

Design notes:

- The evaluator depends only on this interface — never PostgreSQL, Redis,
  DynamoDB, etc.
- Must return a **consistent snapshot** for the traversal of a single check
  (one decision must not mix pre- and post-update relationship states).
- Later versions will expose change streams / version numbers to support
  cache invalidation and consistency modes (roadmap Phases 11, 47).

### Persistent backend: PostgreSQL

The first persistent backend is PostgreSQL (`@uae/persistence`), chosen from
**measured** access patterns rather than intuition — see ADR-0017 for the
benchmark methodology, the numbers, and the recorded reversal triggers.

Headline finding: the evaluator issues a **fixed, small number of queries per
check** (~3.7), the count is **invariant as the graph grows**, and every
result set is tiny (max 1 row in all measured workloads). The workload is
index-covered point lookups, which is what a relational engine is built for.

Schema (`packages/persistence/sql/`):

- `relationships` — primary key on the full edge tuple. **The primary key is the
  idempotency guarantee** (ADR-0018 S5): re-adding an existing relationship is
  `ON CONFLICT DO NOTHING`, so a retried write after a network failure can never
  duplicate state.
- `relationships_subject_idx` on `(subject_type, subject_id, relation)` — the
  forward access direction.
- `relationships_resource_idx` on `(resource_type, resource_id, relation)` — the
  reverse traversal direction.
- `policies` / `policy_deployments` — immutable content-addressed artifacts, with
  activation held in a separate table so publishing and deploying stay distinct
  acts (ADR-0018 S7).

Reads run inside a `REPEATABLE READ` transaction, which is what gives ADR-0018
S2 (snapshot consistency within one check).

**No ORM.** Queries are hand-written and parameterized, so the query plans
ADR-0017 depends on stay visible and the core keeps zero runtime dependencies —
`pg` is confined to `@uae/persistence` (ADR-0005).

## The store contract (ADR-0018)

Every store — in-memory and persistent — must satisfy the same executable suite
in `tests/store-conformance.ts`. It is normative, and it is enforced by tests
rather than by review. In summary:

| Rule | Guarantee                                                                |
| ---- | ------------------------------------------------------------------------ |
| S1   | An unbound query field matches **all** values for that position          |
| S2   | One check never observes a mutation made partway through it              |
| S3   | Identical contents + query ⇒ identical row order (explanations embed it) |
| S4   | Failures throw typed errors — never signalled as an empty result         |
| S5   | Writes are idempotent and safe to retry                                  |
| S6   | Returned rows are frozen                                                 |
| S7   | Publishing a policy never activates it                                   |
| S8   | Artifacts are immutable and content-addressed                            |
| S9   | Unknown version ⇒ `null`; missing active pointer ⇒ error                 |
| S10  | Malformed policy source is rejected and stores nothing                   |

S4 is the one most likely to be got wrong and most dangerous to get wrong:
returning `[]` for "the database is down" would turn an outage into a silent
universal denial and erase the DENIED-vs-AUTHZ_UNAVAILABLE distinction that
`failure-modes.md` requires.

## PolicyStore

```ts
interface PolicyStore {
  getActivePolicy(): Promise<VersionedPolicy>;
  getPolicyVersion(version: string): Promise<VersionedPolicy | null>;
  publishPolicy(policy: PolicySource): Promise<VersionedPolicy>;
}
```

Responsibilities:

- retrieve the currently active policy version
- retrieve any specific version (for reproducibility, rollback, replay)
- publish new versions as **immutable artifacts** (content-addressed hash)
- identify active versions, eventually per-environment (staging v19 /
  production v18)

Publishing is a control-plane concern; data planes only ever read.

## Attribute providers (planned, Phase 45-style design)

External attributes (HR system, device service, app DB) arrive via controlled
providers with `value / source / timestamp / TTL`. Provider failure ⇒
attributes unavailable ⇒ conditions unsatisfied ⇒ default-deny. Cached
attributes must carry freshness metadata; policies may require a maximum
attribute age.

## Explicitly not built yet

No distributed policy-management service, no change-stream infrastructure, no
specialized graph storage. Interfaces first, backends later, benchmark-driven.
