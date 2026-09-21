# Storage

Status: **Interface design**; in-memory stores ship with Phase 2. Persistent
backends are deliberately deferred (Phase 6) until access patterns are
benchmarked.

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

### Likely first persistent backend

PostgreSQL: a `relationships` table indexed on
`(subject_type, subject_id, relation)` and `(resource_type, resource_id,
relation)`. Do not invent a custom graph database until real workloads prove
Postgres insufficient — this keeps the MVP dramatically simpler.

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
