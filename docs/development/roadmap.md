# Roadmap

Statuses: **Implemented** / **Planned** / **Experimental** / **Deferred**.

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
  (S1–S10) lives in `tests/store-conformance.ts` and runs against **every**
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
- `pg` is confined to `@uae/persistence`; the core keeps zero runtime
  dependencies (ADR-0005). The stores depend on a narrow `PgQueryable`
  interface, not on `pg` directly, so SQL construction, error classification, and
  fail-closed behaviour are unit-tested with **no database present**.
- **Docker is never required.** With `AUTHZ_TEST_PG_URL` unset, the Postgres
  suites skip with an explicit message; `pnpm test` stays green on a fresh clone.

Schema, indexes, and the idempotency guarantee are documented in
`../architecture/storage.md`. Access-pattern measurement: `pnpm bench`.

## Phase 7 — Performance 🔜 Planned

Policy/relationship/decision caching per `../architecture/caching.md`
(invalidation requirements first), batch evaluation, profiling, benchmarks
(simple RBAC, deep traversal, large graphs, large policies, batch checks).

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
