# Testing Strategy

> Authorization bugs are security bugs. Testing is not optional here.

Framework: Vitest (ADR-0003). Run with `pnpm test` (PowerShell-friendly).

## Levels

The suites currently live **flat in `tests/`** — one file per concern, named for
the level it belongs to. Security and CLI suites are identified by filename
prefix (`security-*`, `cli-*`), so the level is visible without a directory
hierarchy that would only be re-litigated later.

### 1. Unit tests

`tests/*.test.ts` — domain and language primitives. Cover:

- identifier parsing/validation (malformed inputs rejected)
- subject/resource/action/context validation
- relationship record validation
- policy language lexer/parser (positions, malformed input)
- policy validation and lowering

### 2. Evaluator and integration tests

`tests/evaluator-*.test.ts`, `tests/policy*.test.ts`,
`tests/explanations.test.ts`, `tests/helpers.ts` — policy store + relationship
store + evaluator together, over the canonical Acme example domain
(`examples/acme/`). Includes:

- RBAC, ReBAC inheritance, and revocation paths
- determinism (same inputs → same decision **and** explanation)
- explanation levels never changing a decision
- cross-representation equivalence (text policy == programmatic policy)

### 3. Security tests

`tests/security-*.test.ts` — explicit adversarial coverage:

- tenant isolation (cross-tenant reads/writes, inherited permissions,
  shared resources, service identities)
- privilege escalation paths
- malformed policies / malformed relationships
- cyclic graphs terminate
- **default-deny on every error path** (evaluation errors never produce ALLOW)

### 4. CLI tests

`tests/cli-*.test.ts` — the CLI is exercised through `run(argv, io)` with
captured io and temporary directories, so real code paths run **without
spawning processes**. Coverage:

- argument parsing (flags, `--flag=value`, `--`, help, usage errors)
- exit codes for each command, including `3` for deny vs `4` for infrastructure
- `--json` output shapes (the documented CI contract)
- the round-trip that `authz init` output validates and tests clean

Exactly one smoke test spawns the built binary, to prove the `bin`/shebang
wiring works on Windows as well as Linux.

### 5. SDK tests

`tests/sdk-*.test.ts` — the stable client surface: request normalization,
the decision/unavailable outcome taxonomy, per-item batch isolation,
determinism, and parity with the raw evaluator (the SDK must add no semantics).

### 6. Persistence and store-contract tests

`tests/persistence-*.test.ts`, `tests/store-conformance.ts` — the store contract
(ADR-0018) is expressed **once** and run against every backend, the in-memory
reference included, so a backend is correct by passing the same spec rather than
by review:

- `store-conformance.test.ts` — the contract against the in-memory reference.
- `persistence-sql.test.ts` — SQL construction, identifier handling, error
  classification, and fail-closed behaviour through a recording `PgQueryable`
  double. No database required, so it runs on a fresh clone.
- `persistence-postgres.test.ts` — the same contract against a **live**
  PostgreSQL server, plus durability across connections and migration
  idempotency. It skips with an explicit message when `AUTHZ_TEST_PG_URL` is
  unset (see `local-development.md`).

Both halves are needed. The double runs everywhere and pins the SQL the stores
issue; the live run is what caught the two defects the double could not express
— node-postgres returning an **array** of results for a multi-statement
migration file, and a `UNIQUE` content hash that contradicted S8 by rejecting a
legitimate republish.

### 7. Property tests (Phase 7)

`tests/evaluator-property.test.ts` (fast-check, devDependency): generative
properties over Acme-shaped graphs with the policy fixed to `ACME_POLICY` —
generated policies would test the generator, not the engine:

- removal is monotone (a DENY never becomes an ALLOW)
- edges from a disjoint identifier namespace cannot change a decision
- agreement with a naive reference permission closure on every generated
  graph (catches depth, cycle, and inheritance handling concrete cases miss)
- a fully-cached evaluator agrees with a fresh one across generated op
  sequences (grant/revocation immediacy, generatively)

### 8. Performance tests (Phase 7)

`pnpm bench` (harness: `scripts/bench.mjs`) reports, per workload and per
backend (memory always; PostgreSQL when `AUTHZ_TEST_PG_URL` is set):

- uncached arm: check latency, query shapes, queries per check, and a stage
  profile aggregating observer `elapsedMs` (where check time goes)
- decision-cache arm: cold and warm passes over the repeating stream
- relationship-cache arm: the distinct stream isolating shared
  sub-traversal collapsing
- batch arm: `checkBatch` chunked at `maxBatchSize` versus N × `check` on
  the same stream (version reads per check, `decisionsMatch`)

Workloads cover simple RBAC (`small`), scale (`medium`), fan-out
(`deep-fanout`), and the wide-clause `large-policy` variant with an extra
hierarchy level. **No performance numbers are documented before measuring**
— the measured values live in `roadmap.md` Phase 7.

## Rules

- Every documented behavior must have a test; undocumented behavior is a bug.
- The evaluator's determinism is tested: same inputs → same decision and
  explanation.
- Fixtures live in `examples/` (single canonical domain, per
  `../design/domain-model.md`) with shared test wiring in `tests/helpers.ts`.
- Tests must not depend on the developer's working directory or leave files
  behind; use `node:os` temporary directories.
