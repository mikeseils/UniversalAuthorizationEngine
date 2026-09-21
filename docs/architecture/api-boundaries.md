# API Boundary Strategy

Status: design (public APIs stabilize with the SDK phase; all exported types
carry a draft marker until then).

## Layering rule

```
cli / sdk / adapters   (may import evaluator, policy, core)
evaluator              (may import policy, core)
policy                 (may import core)
core                   (imports nothing from the project)
```

The dependency direction is one-way and enforced in review and CI. `core`
contains domain types and interfaces only.

## Stability levels

| Level  | Meaning                                                                         | Current                  |
| ------ | ------------------------------------------------------------------------------- | ------------------------ |
| Draft  | Shape may change without notice; documented reasoning required before promotion | All exported types today |
| Stable | Semantic versioning applies; breaking changes require an ADR                    | none yet                 |

Rules:

- Before stabilizing any public API (SDK, CLI, HTTP), an ADR must record the
  design reasoning (shapes, error taxonomy, explanation disclosure levels).
- Anything exported from `packages/*/src/index.ts` is public and must be
  documented; anything else is internal and not covered by semver guarantees.
- Wire formats (HTTP, persisted policy artifacts) are versioned independently
  from code APIs and may not borrow "draft" freedom — persisted artifacts
  need explicit format versions from day one.

## Public API surface (target)

```ts
check(request: AuthorizationRequest): Promise<AuthorizationDecision>
checkBatch(requests: AuthorizationRequest[]): Promise<AuthorizationDecision[]>
// later, gated on model correctness:
// explain(...)  listAuthorized(...)
```

The surface stays intentionally small. `listAuthorized()` is not implemented
until the authorization and storage models support it correctly.
