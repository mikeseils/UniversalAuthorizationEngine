# ADR-0005: Monorepo layout and package boundaries

- Status: Accepted
- Date: 2026-09-21

## Context

The repository layout should create real architectural boundaries, not
theoretical ones.

## Decision

Use a pnpm workspace with these packages:

| Package              | Responsibility                                                                                             | Phase 0 status            |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------- |
| `packages/core`      | Domain model: identifiers, subjects/resources/actions, requests, decisions, explanations, store interfaces | **Implemented (initial)** |
| `packages/policy`    | Policy representation, parsing, validation, versioning                                                     | Planned (Phase 3)         |
| `packages/evaluator` | Deterministic decision engine: policy + relationships + context → decision + explanation                   | Planned (Phase 2+)        |
| `packages/sdk`       | Developer-facing client API (`check()`, `checkBatch()`)                                                    | Planned (Phase 5)         |
| `packages/cli`       | `authz` CLI (`init`, `validate`, `test`, `check`)                                                          | Planned (Phase 4)         |

## Boundary rationale

- **`core` is dependency-free** (no framework, DB, cloud, or IdP dependencies).
  Everything else may depend on `core`; nothing inside `core` depends on
  anything else. Adapters wrap the core, never the reverse.
- `policy` and `evaluator` are separate because policy authoring/validation
  (control-plane work, offline, in CI) is lifecycle-distinct from decision
  evaluation (data-plane work, latency-sensitive).
- `sdk` and `cli` are thin consumers of the packages above; keeping them
  separate prevents core from growing service-specific or
  developer-ergonomics-only concerns.

`examples/` (canonical Acme domain, `tests/` (cross-package integration and
security tests), and `scripts/` are workspace-level, not packages.
