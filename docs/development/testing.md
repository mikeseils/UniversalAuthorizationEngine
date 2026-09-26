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

### 6. Property tests (Phase 7)

Invariants, e.g.:

- adding an unrelated relationship cannot grant unrelated access
- removing a required relationship cannot turn deny into allow

These are covered by concrete cases today (`tests/evaluator-acme.test.ts`,
`tests/security-*.test.ts`); generative/property-based testing arrives with the
performance phase.

### 7. Performance tests (Phase 7)

Benchmarks for simple RBAC, deep traversal, large graphs/policies, batch
checks. **No performance numbers are documented before measuring.**

## Rules

- Every documented behavior must have a test; undocumented behavior is a bug.
- The evaluator's determinism is tested: same inputs → same decision and
  explanation.
- Fixtures live in `examples/` (single canonical domain, per
  `../design/domain-model.md`) with shared test wiring in `tests/helpers.ts`.
- Tests must not depend on the developer's working directory or leave files
  behind; use `node:os` temporary directories.
