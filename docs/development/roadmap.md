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

## Phase 2 — In-memory evaluator 🔜 Planned

Simple structured policy representation; in-memory `RelationshipStore` and
`PolicyStore`; deterministic evaluator; allow/deny; explanations (same pass as
decision); explanation detail levels; bounded traversal; cycle safety;
integration tests with the canonical Acme example; security tests (tenant
isolation, malformed inputs, default-deny error paths).

## Phase 3 — Policy language 🔜 Planned

Final language decision ADR (extends ADR-0008 study); parser, AST, validation,
compiled policy artifacts, versioning; `authz validate` semantics designed;
static analysis groundwork.

## Phase 4 — CLI 🔜 Planned

`authz init`, `authz validate`, `authz test`, `authz check` — only commands
backed by real functionality.

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
