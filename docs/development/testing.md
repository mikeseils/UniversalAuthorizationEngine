# Testing Strategy

> Authorization bugs are security bugs. Testing is not optional here.

Framework: Vitest (ADR-0003). Run with `pnpm test` (PowerShell-friendly).

## Levels

### 1. Unit tests

Next to source (`*.test.ts`). Cover:

- identifier parsing/validation (malformed inputs rejected)
- subject/resource/action/context validation
- relationship record validation
- parser (Phase 3)
- policy validation (Phase 3)
- relationship resolution, evaluator, context evaluation,
  explanation generation (Phase 2)

### 2. Property tests (Phase 7)

Invariants, e.g.:

- adding an unrelated relationship cannot grant unrelated access
- removing a required relationship cannot turn deny into allow

### 3. Integration tests

`tests/integration/` — policy store + relationship store + evaluator together,
using the canonical Acme example domain (`examples/`).

### 4. Security tests (start in Phase 2)

`tests/security/` — explicit adversarial coverage:

- tenant isolation (cross-tenant reads/writes, inherited permissions,
  shared resources, service identities)
- privilege escalation paths
- malformed policies / malformed relationships
- stale data behavior
- cyclic graphs terminate
- **default-deny on every error path** (evaluation errors never produce ALLOW)

### 5. Performance tests (Phase 7)

Benchmarks for simple RBAC, deep traversal, large graphs/policies, batch
checks. **No performance numbers are documented before measuring.**

## Rules

- Every documented behavior must have a test; undocumented behavior is a bug.
- The evaluator's determinism is tested: same inputs → same decision and
  explanation.
- Fixtures live in `tests/fixtures/` and `examples/` (single canonical domain,
  per `../design/domain-model.md`).
