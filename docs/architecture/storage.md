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
  acts (ADR-0018 S7). `hash` is **indexed, not unique**: republishing identical
  content must mint a _new_ version (S8), so a uniqueness constraint there would
  turn a legitimate republish into a constraint violation. Versions are
  allocated by the `policy_versions` sequence, so two store instances sharing
  one database can never mint the same version.

Reads run inside a `REPEATABLE READ` transaction, which is what gives ADR-0018
S2 (snapshot consistency within one check). The conformance suite proves this
against a live database rather than trusting the comment: a second connection
commits an insert mid-transaction, and the in-snapshot re-read still returns the
original row set — no phantom reads.

`uae_schema_migrations` records which files a database has applied. The record is
written in the **same transaction** as the migration body, so a crash can never
leave a file marked applied whose schema was never created. Idempotent SQL alone
would not catch that; it is the transaction that makes the bookkeeping truthful.

**No ORM.** Queries are hand-written and parameterized, so the query plans
ADR-0017 depends on stay visible and the core keeps zero runtime dependencies —
`pg` is confined to `@uae/persistence` (ADR-0005).

## Connection safety

`node-postgres` defaults are unsafe for an authorization path, so both are
overridden:

- **Unbounded waits.** `pg` waits _forever_ for a pooled client. An unreachable
  database would therefore hang the request instead of raising something the
  caller can react to. `createPgQueryable` bounds the connection wait (5s) and
  idle lifetime (30s); an optional server `statement_timeout` can be forwarded.
- **Fatal idle-client errors.** When the server drops an _idle_ client, `pg`
  raises `ECONNRESET` on a promise nobody is awaiting. With no `error` listener
  that becomes an unhandled event and **terminates the host process**. A pool
  error listener is therefore mandatory, not optional: it routes the failure to a
  caller-supplied sink, or to `process.emitWarning` when none is configured — so a
  disturbance is never silent and never fatal.

## Error taxonomy (ADR-0020)

Driver failures are mapped to typed errors, so callers never parse `err.code` or
`err.message`:

| Driver signal                                                                        | Reason           | Class                   |
| ------------------------------------------------------------------------------------ | ---------------- | ----------------------- |
| `42P01`, `42703`                                                                     | `schema_missing` | `PersistenceError`      |
| `57014`, `ETIMEDOUT`, message matching `/timeout/i`                                  | `timeout`        | `StoreTimeoutError`     |
| `ECONN*`, `EPIPE`, `ENOTFOUND`, SQLSTATE `08xxx`, `57P01`, "connection … terminated" | `unavailable`    | `StoreUnavailableError` |
| anything else                                                                        | `query_failed`   | `PersistenceError`      |

`timeout` is kept separate from `unavailable` on purpose: both fail closed, but
a timeout is a capacity/latency signal (add an index, raise a bound) while
unavailability is a connectivity signal (fix the network, restart the server).
Collapsing them would turn a tuning signal into a paging incident. Every reason
throws, and none is ever an `allowed: false`.

## The store contract (ADR-0018)

Every store — in-memory and persistent — must satisfy the same executable suite
in `tests/store-conformance.ts`. It is normative, and it is enforced by tests
rather than by review. In summary:

| Rule | Guarantee                                                                             |
| ---- | ------------------------------------------------------------------------------------- |
| S1   | An unbound query field matches **all** values for that position                       |
| S2   | One check never observes a mutation made partway through it                           |
| S3   | Identical contents + query ⇒ identical row order (explanations embed it)              |
| S4   | Failures throw typed errors — never signalled as an empty result                      |
| S5   | Writes are idempotent and safe to retry                                               |
| S6   | Returned rows are frozen                                                              |
| S7   | Publishing a policy never activates it                                                |
| S8   | Artifacts are immutable and content-addressed; every publish mints a distinct version |
| S9   | Unknown version ⇒ `null`; missing active pointer ⇒ error                              |
| S10  | Malformed policy source is rejected and stores nothing                                |
| S11  | State version is opaque (`!==` only), side-effect free to read, moves iff state moved |

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
