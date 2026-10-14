# API Boundary Strategy

Status: design. The SDK's public surface is now recorded in **ADR-0015** and
**ADR-0016** and is treated as the stability reference for client code; every
other exported type still carries a draft marker until it is promoted here.

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

| Level  | Meaning                                                                         | Current                   |
| ------ | ------------------------------------------------------------------------------- | ------------------------- |
| Draft  | Shape may change without notice; documented reasoning required before promotion | Most exported types       |
| Stable | Semantic versioning applies; breaking changes require an ADR                    | `@uae/sdk` client surface |

Rules:

- Before stabilizing any public API (SDK, CLI, HTTP), an ADR must record the
  design reasoning (shapes, error taxonomy, explanation disclosure levels).
- Anything exported from `packages/*/src/index.ts` is public and must be
  documented; anything else is internal and not covered by semver guarantees.
- Wire formats (HTTP, persisted policy artifacts) are versioned independently
  from code APIs and may not borrow "draft" freedom — persisted artifacts
  need explicit format versions from day one.

## Public API surface

The client surface implemented in `packages/sdk` (ADR-0015, ADR-0016):

```ts
normalizeClientRequest(req: ClientRequest): AuthorizationRequest

class AuthzClient {
  static fromEvaluator(evaluator: Evaluator): AuthzClient;
  static inMemory(options: InMemoryClientOptions): Promise<AuthzClient>;

  check(req: ClientRequest, options?: ClientCheckOptions): Promise<CheckOutcome>;
  isAllowed(req: ClientRequest, options?: IsAllowedOptions): Promise<boolean>;
  checkBatch(
    reqs: readonly ClientRequest[],
    options?: ClientCheckOptions,
  ): Promise<readonly CheckOutcome[]>;
}

type CheckOutcome =
  | { outcome: "decision"; decision: AuthorizationDecision }
  | { outcome: "unavailable"; error: AuthorizationUnavailableError };
```

The underlying engine surface remains:

```ts
check(request: AuthorizationRequest): Promise<AuthorizationDecision>
checkBatch(requests: AuthorizationRequest[]): Promise<AuthorizationDecision[]>
// later, gated on model correctness:
// explain(...)  listAuthorized(...)
```

The evaluator also exports (draft, ADR-0021) the opt-in caching surface:

```ts
new Evaluator({ ..., decisionCache?: DecisionCache })   // default: no cache
class DecisionCache { get/set/clear/stats }             // version-keyed entries
decisionCacheKey(input): string                         // canonical key builder
```

A `DecisionCache` requires a relationship store with the ADR-0018 S11 version
surface; construction fails otherwise rather than degrading to an unkeyed
cache.

The surface stays intentionally small. `listAuthorized()` is not implemented
until the authorization and storage models support it correctly.
