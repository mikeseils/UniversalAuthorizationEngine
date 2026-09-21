# Evaluation Model

Status: **Design implemented conceptually; evaluator implementation Planned
(Phase 2).** The semantics in this document are binding.

## Pipeline

```
CheckRequest
    ↓ Normalize             parse/validate subject, action, resource, context
    ↓ Load relevant policy   exact immutable version (PolicyStore interface)
    ↓ Resolve relationships  bounded traversal (RelationshipStore interface)
    ↓ Evaluate conditions    deterministic, side-effect free
    ↓ Produce decision       ALLOW | DENY
    ↓ Produce explanation    optional; generated from the same evaluation pass
```

## Binding semantics

### Truth values

Evaluation computes a three-valued result internally: **true / false /
unknown**, collapsing to a two-valued decision at the end:

- any branch evaluating to `true` → ALLOW
- otherwise → DENY

`unknown` arises from missing relationships, unavailable attributes, or
evaluation errors. **`unknown` is never treated as `true`** (ADR-0006).
A decision error path yields an explicit explained DENY or a typed
infrastructure error — never an ALLOW.

### Connectives

- `A or B` — short-circuit on `true`; otherwise, if any operand is `unknown`,
  result is `unknown` (→ deny unless another top-level branch is `true`).
- `A and B` — short-circuit on `false`; if any operand is `unknown` (and none
  is `false`), result is `unknown` (→ deny).
- `not A` — `true`/`false` flip; `not unknown` is `unknown` (→ deny).
  Note: policies relying on `not` to _grant_ require an affirmative `true`
  operand; `not missing-data` never grants. (Future static analysis should
  warn about negation-based grants.)

### Relationship traversal

- Traversal follows edges defined by the policy for the requested permission.
- **Bounded**: maximum depth and fan-out; exceeding bounds → `unknown` → DENY
  plus an explanation marker, never an error-driven ALLOW.
- **Cycles**: revisiting an already-visited (subject, relation, resource) node
  terminates that path — cycles cannot cause non-termination.
- Missing relationship data ⇒ the required branch is unsatisfied.

### Determinism & purity

- Same (policy version, relationship snapshot, request) → identical decision
  **and identical explanation**.
- No network, clock, randomness, or I/O inside evaluation. Time/context enters
  only as validated request data.

### Observability

- The evaluator emits structured trace events (stages, timings, branch
  outcomes) through an injected observer interface — never direct logging.
- Nothing sensitive is logged by default; explanations obey the disclosure
  rules in `explanations.md`.

## Interfaces (draft, non-final)

```ts
interface AuthorizationRequest {
  subject: Subject;
  action: Action;
  resource: Resource;
  context?: AuthorizationContext;
}

interface AuthorizationDecision {
  allowed: boolean;
  explanation?: AuthorizationExplanation;
  policyVersion?: string;
}

interface RelationshipStore {
  getRelationships(query: RelationshipQuery): Promise<Relationship[]>;
}

interface PolicyStore {
  getActivePolicy(): Promise<VersionedPolicy>;
  getPolicyVersion(version: string): Promise<VersionedPolicy | null>;
  publishPolicy(policy: PolicySource): Promise<VersionedPolicy>;
}
```

Design reasoning to record before stabilizing any public API: decision shapes,
error taxonomy, and explanation levels each get an ADR in Phase 2/5. Until
then all exported types carry a "draft" marker in their TSDoc.

## In-memory stores

Phase 0–2 ship in-memory `RelationshipStore` and `PolicyStore`
implementations for unit tests, local development, and examples. Persistent
adapters are explicitly out of scope until access patterns are benchmarked
(roadmap Phase 6).
