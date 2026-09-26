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

## Phase 5 — SDK 🔜 Planned

TypeScript SDK (`check`, `checkBatch`); distinct DENIED vs
AUTHZ_UNAVAILABLE error semantics; Python/Go SDKs later.

## Phase 6 — Persistence 🔜 Planned

Persistent relationship + policy stores. Database choice **after** access
patterns are benchmarked and documented (Postgres is the likely first
candidate; no custom graph DB until proven necessary).

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
