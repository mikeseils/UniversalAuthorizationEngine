# Roadmap

Statuses: **Implemented** / **Planned** / **Experimental** / **Deferred** /
**In progress**.

## Phase 0 — Repository foundation ✅ Implemented

Git, pnpm workspace, TypeScript (strict), ESLint + Prettier, Vitest, CI,
documentation, ADRs, `.gitignore` for Node/TS/VS Code/Windows/build/coverage/
secrets/local DBs.

## Phase 1 — Domain model ✅ Implemented (initial)

`packages/core`: Subject, Resource, Action, Context, Relationship, policy
identifiers, `AuthorizationRequest`, `AuthorizationDecision` (draft shapes,
documented as non-final), identifier parsing/validation, invariants tests.

## Phase 2 — In-memory evaluator ✅ Implemented

Structured policy representation, validation, compilation (content-hashed,
immutable `VersionedPolicy` artifacts) and the in-memory `PolicyStore`
(`packages/policy`); in-memory `RelationshipStore` with snapshot-consistent
reads and a `relationshipVersion` counter; the deterministic `Evaluator` with
three-valued semantics (true/false/unknown → deny), bounded cycle-safe ReBAC
traversal, `indirect` inheritance, context conditions, same-pass explanations
with disclosure levels, `check()` + `checkBatch()`, provenance fields
(`policyVersion`); unit, integration, and security test suites (tenant
isolation, fail-closed error paths, cycles, bounds, batch, explanations —
108 tests). See ADR-0009/0010/0011.

## Phase 3 — Policy language ✅ Implemented (v1)

Policy language v1 decided in **ADR-0012** (small declarative ReBAC syntax,
Zanzibar/OpenFGA lineage; `not`, arithmetic, functions, and permission
composition deliberately excluded). Implemented in `packages/policy`: lexer
(token positions, BOM tolerance, 256 KB source cap), recursive-descent parser
with located errors, AST, lowering (`targetType.permission` traversals resolved
from relation declarations — ambiguity is a validation error, never a guess),
the source pipeline (`compilePolicySource`: parse → lower → validate → compile),
and `InMemoryPolicyStore` accepting **text or structured** source through one
publish path. The canonical policy is authored in the language at
`examples/acme/policy.authz`.

Tests: lexer/parser error cases and positions, publish-time rejection of
malformed and oversized source, and **cross-representation equivalence** (the
text Acme policy produces identical decisions to the programmatic one across
every case) — 145 tests total. Static analysis (`authz analyze`) and the
language-maturity items of Phase 13 remain **Planned**.

## Phase 4 — CLI ✅ Implemented

Policy language and evaluator are accessible locally via the `authz` CLI:
`authz validate` (syntax + schema verification), `authz test` (declarative
assertion runner), `authz check` (one-off evaluation), and `authz init` (starter
scaffold). Implemented in `packages/cli` (ADR-0013, ADR-0014). Supported
commands are backed by real functionality; `analyze` and `bench` remain planned.

## Phase 5 — TypeScript SDK ✅ Implemented

`@uae/sdk` is the stable client surface for application developers (ADR-0015,
ADR-0016). `AuthzClient.check()` returns a **discrete, typed outcome** rather than
a bare boolean or an exception:

```ts
type CheckOutcome =
  | { outcome: "decision"; decision: AuthorizationDecision }
  | { outcome: "unavailable"; error: AuthorizationUnavailableError };
```

A denial (`allowed: false`) is a decision; an infrastructure failure is
`unavailable` — never collapsed into either a `false` or a thrown `Error`
(ADR-0006, `docs/architecture/failure-modes.md`). Clients:

- accept ergonomic requests (`subject: "user:alice"` or
  `{ type: "user", id: "alice" }`) and fail fast with `ValidationError` at the
  boundary, before any dispatch;
- offer `isAllowed()` for guard sites — throwing on `unavailable` by default, with
  an explicit opt-in `onUnavailable: "deny"` for fail-closed paths, and **no API
  path that can fail open**;
- offer `checkBatch()` with 1:1 positional results and per-item isolation: one
  item's infrastructure failure never fabricates decisions nor discards its
  siblings' valid decisions;
- are transport-agnostic (`ClientTransport`), with an in-process transport
  today and a network transport reserved for the Phase 8 data plane.

Client construction is `AuthzClient.fromEvaluator(evaluator)` or the ergonomic
`AuthzClient.inMemory({ policy, relationships })`. Test suites cover request
normalization, the outcome taxonomy, batch limits and isolation, and **parity
with the raw evaluator** over the canonical Acme domain — the SDK adds no
semantics of its own. Python/Go SDKs remain later.

## Phase 6 — Persistence ✅ Implemented

PostgreSQL relationship and policy stores (`@uae/persistence`), chosen from
**measured** access patterns rather than assumption, as the roadmap required.

- **ADR-0017** records the benchmark methodology and the numbers. The decisive
  finding: the evaluator issues a **fixed ~3.7 store queries per check**, and
  that count is **invariant across a 9x growth in relationships** (176 →
  1,632). Result sets are tiny (max 1 row). The workload is index-covered point
  lookups, so the current bottleneck is the in-memory store's linear scan — an
  indexing problem, not a graph problem. No evidence of the super-linear
  traversal that would justify a specialized store. The ADR also records
  **reversal triggers**, so the decision is falsifiable rather than dogmatic.
- **ADR-0018** makes the store semantics **executable**: the normative contract
  (S1–S11) lives in `tests/store-conformance.ts` and runs against **every**
  backend, the in-memory reference included. A new backend is not done until it
  passes unmodified. The subtle requirements are called out explicitly —
  unbound-means-all, snapshot consistency, deterministic ordering, typed
  failures that are never signalled as an empty result, and publish-never-
  activates.
- **ADR-0019** closes the Phase 4 deferral: `CheckOptions.policyVersion` pins an
  exact artifact. Pinning is opt-in (default unchanged), an unknown version
  raises `PolicyNotFoundError` rather than falling back — silently evaluating a
  different policy would produce a decision attributed to a policy that did not
  produce it — and it surfaces as a _caller_ error, not `AUTHZ_UNAVAILABLE`.
- **ADR-0020** makes the failure taxonomy executable rather than advisory:
  `StoreUnavailableError` and `StoreTimeoutError` are real subclasses, so a
  caller branches on `instanceof` instead of parsing `err.code` or
  `err.message`. The classification table is normative, asserted row by row, and
  `timeout` is deliberately _not_ folded into `unavailable` — they have the same
  fail-closed posture but demand different operator responses.
- The pool is bounded and survives the failure modes `node-postgres` defaults
  into. `pg` waits **forever** for a pooled client by default, which turns an
  unreachable database into a hung authorization request, so connection and idle
  timeouts are set explicitly; and an idle client dropped by the server raises
  `ECONNRESET` on a promise **nobody is awaiting**, which without a listener
  becomes an unhandled `'error'` event that kills the host process. A mandatory
  pool error listener routes those to a sink, falling back to
  `process.emitWarning` so a disturbance is never lost and never fatal.
- Concurrency is **proven, not asserted**. Live tests demonstrate atomic batch
  writes (all-or-nothing), `REPEATABLE READ` snapshot isolation against a
  concurrent committing writer (no phantom reads), and idempotent concurrent
  writes resolving to exactly the right row set.
- Migrations are **tracked**, not merely idempotent: applied files are recorded
  in `uae_schema_migrations` in the same transaction as the migration body, so a
  crash can never leave a file marked applied whose schema was never created.
- **CI provisions PostgreSQL and refuses to skip.** A `postgres:16-alpine`
  service container runs the suites with `AUTHZ_REQUIRE_PG_TESTS=1`, which turns
  "Postgres unreachable" from a silent skip into a **failing** suite. Without
  that guard, a misconfigured service container would report green while testing
  nothing.
- The CLI can evaluate against a real database — `authz check --store postgres`
  (or `AUTHZ_STORE`) with `AUTHZ_DATABASE_URL` — and the same request must yield
  the same decision from either backend, which is the store contract's whole
  point. The in-memory default is unchanged.
- `pg` is confined to `@uae/persistence`; the core keeps zero runtime
  dependencies (ADR-0005). The stores depend on a narrow `PgQueryable`
  interface, not on `pg` directly, so SQL construction, error classification, and
  fail-closed behaviour are unit-tested with **no database present**.
- **Docker is never required for development.** With `AUTHZ_TEST_PG_URL` unset,
  the Postgres suites skip with an explicit message; `pnpm test` stays green on a
  fresh clone. CI is the environment where skipping is not allowed.
- **The live run was the real gate, not a formality.** The first suite run
  against actual PostgreSQL failed on defects the recording double could not
  express: node-postgres hands back an **array** of results for a multi-statement
  migration file (so migrations aborted before a single contract case ran), the
  initial policy schema declared the content `hash` `UNIQUE`, contradicting S8
  (republishing identical content must mint a **new** version, because versions,
  not hashes, are the unit of audit and rollback), and `pg`'s unbounded default
  wait plus its fatal unhandled-idle-client error would each have taken down a
  host process rather than failing a test. All are fixed and covered, and a live
  database stays part of the definition of done for a persistent backend.
- `pnpm bench` measures **both** backends with one harness. The ADR-0017 claim
  now holds as a measurement: queries-per-check is **3.67 on memory and 3.67 on
  PostgreSQL**, identical across a 9x growth in data. The database changes
  latency (p95 ~0.05ms → ~2ms, dominated by round-trips) but not the shape of
  the workload, so the indexing conclusion is unaffected.

Schema, indexes, error taxonomy, and the idempotency guarantee are documented in
`../architecture/storage.md`. Access-pattern measurement: `pnpm bench`.

## Phase 7 — Performance 🟢 Complete

- **Invalidation requirements first**, per `../architecture/caching.md`:
  **ADR-0018 S11** adds the opaque, side-effect-free relationship-state version
  every store must expose (conformance-enforced — reading the version never
  advances it, a no-op write never moves it), and **ADR-0021** implements the
  version-keyed decision cache: keys incorporate policy + relationship
  versions so invalidation is deterministic, TTL/LRU are memory bounds only,
  `reason: "error"` decisions are never cached, entries are frozen against
  caller-side poisoning, and a cache without a version source is a
  construction-time error rather than a silently unkeyed cache. Security tests
  cover revocation/grant immediacy and context/subject isolation of entries;
  `pnpm bench` measures cold and warm cache passes on both backends.
- **ADR-0022** adds the version-keyed policy artifact cache (immutable,
  content-addressed artifacts; the active path drops from two store
  round-trips to one via the `getActiveVersion` pointer surface) and
  **ADR-0023** the generation-keyed relationship query cache (entries keyed by
  canonical query + opaque state version, served through a per-check store
  view — collapses the shared sub-traversals within a burst of distinct
  checks). The integrated suite `tests/security-caching.test.ts` pins
  revocation/grant immediacy, policy-republish immediacy, tenant isolation,
  poisoning resistance, and fail-closed recovery with **all three caches
  configured together**; `pnpm bench` also reports the distinct-stream
  relationship-cache arm.
- The phase closes with **stage profiling**, the **extended benchmark matrix**, and **generative property tests**. Every workload's uncached arm aggregates observer `elapsedMs` per stage and prints a stage profile (decision time dominates at 93-99%, policy load ~1%, normalize rounds to zero) with no engine changes. The batch arm reports `checkBatch` chunked at `maxBatchSize` against N x `check` on the same stream: version reads drop from **one per item to one per chunk** (1.00 -> 0.01/check) with `decisionsMatch=true`. The `large-policy` workload adds a `folder` level (org -> project -> folder -> document, wider clauses, mixed shallow/deep allows): **4.17** queries/check uncached, collapsed to 0.32 by the relationship cache at 94% hit rate. `tests/evaluator-property.test.ts` (fast-check) covers removal monotonicity, disjoint-namespace inertness, reference-closure parity, and cached-vs-fresh agreement across generated op sequences. Dependency tracking and explicit consistency modes remain open (Phase 10+).

## Phase 8 — Production architecture 🔜 Planned

Control plane, data plane, API, authentication, deployment, observability,
policy artifact signing, disaster recovery.

## Phase 9 — Enterprise features 🔜 Planned

SSO/IdP integration (Okta, Entra ID, Google Workspace, LDAP, SAML, OIDC —
consume identity, never own authentication); SCIM provisioning; policy
governance (ownership, review/approval workflow, separation of duties);
compliance exports (machine-readable evidence, not a compliance platform).

## Phase 10+ — Longer horizon 🔜 Planned / 🔭 Deferred

- High-performance deployment modes: remote, local cache, sidecar, embedded
- Distributed authorization graph, consistency model (`eventual`/`bounded`/
  `strong` as explicit API choices)
- Policy language maturity (deliberately constrained growth), static policy
  analysis, policy fuzzing, policy simulator, policy CI/CD, policy packages &
  marketplace
- Temporal/delegated authorization, external principals, federation
- Database-aware authorization (predicates, Postgres RLS), the list problem
- Framework & GraphQL adapters, event-driven relationship sync, idempotent
  relationship APIs
- Edge & offline authorization, multi-region
- AI-agent authorization (agents as first-class subjects; `acts_on_behalf_of`;
  tool/amount/human-approver context) — architecturally anticipated from
  Phase 1, productized when the core is stable
- Human approval as a policy primitive (`requires_approval` decision outcome)
- Authorization observability & anomaly detection, decision provenance &
  replay, standardization/open specification

These later phases are **vision, not commitments**; the MVP discipline
documented in the product vision governs: a small ReBAC-oriented core, a fast
local evaluator, SDKs, policy tests, and excellent explanations.
