# Architecture Overview

Status: architecture **direction**; only the `core` package boundary is
implemented so far.

## Guiding principles

1. **Small abstractions.** Core is `policy + relationship data + request →
decision`. No framework creep (see ADR-0005).
2. **Core independence.** The core depends on no web framework, database,
   cloud provider, identity provider, or frontend framework. Adapters exist
   _around_ the core.
3. **Correctness over speed** of delivery — deterministic, secure, testable,
   explainable, isolated, backwards-compatible, explicit failure modes.
4. **Default deny** (ADR-0006).

## Layered shape

```
┌────────────────────────────────────────────────────────────┐
│ Consumers: applications, CLI, CI, dashboards               │
├────────────────────────────────────────────────────────────┤
│ SDK (packages/sdk)        CLI (packages/cli)               │
├────────────────────────────────────────────────────────────┤
│ Evaluator (packages/evaluator)                             │
│   policy + relationships + request → decision + explanation│
├────────────────────────────────────────────────────────────┤
│ Policy (packages/policy)  parse/validate/compile/version   │
├────────────────────────────────────────────────────────────┤
│ Core (packages/core)      domain types + store interfaces  │
│                            (zero dependencies)             │
└────────────────────────────────────────────────────────────┘
```

Dependency rule: arrows point downward only. `core` has no dependencies.

## Deployment models (all must remain possible)

| Model       | Shape                                  | Status                                                  |
| ----------- | -------------------------------------- | ------------------------------------------------------- |
| Embedded    | Application in-process with the engine | Architecturally supported; core is embeddable by design |
| Sidecar     | SDK → localhost sidecar process        | Planned (Phase 10)                                      |
| Self-hosted | Customer's authorization cluster       | Planned (Phase 8)                                       |
| Hosted      | Managed service                        | Planned (Phase 8+); commercial layer                    |

The evaluator's interface-driven design (PolicyStore/RelationshipStore) is what
keeps all four open.

## Repository layout

See ADR-0005 for package boundaries and rationale.

## Key component notes

- **Policy compiler** (planned): source → parser → validator → compiler →
  immutable artifact; enables optimization, static analysis, deterministic
  deployment artifacts.
- **Relationship store**: interface in core; in-memory implementation first;
  PostgreSQL adapter is the likely first persistent backend (roadmap Phase 6) —
  chosen _after_ benchmarking access patterns.
- **Caching**: see `caching.md` — decision caching is dangerous and gated on
  documented invalidation requirements.
- **Failure handling**: see `failure-modes.md` — always fail-closed, with the
  DENIED vs AUTHZ_UNAVAILABLE distinction.
