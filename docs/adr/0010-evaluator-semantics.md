# ADR-0010: Evaluator semantics, bounds, and error taxonomy

- Status: Accepted
- Date: 2026-09-21

## Decision

### Three-valued evaluation

Internal truth values are `true | false | unknown`, collapsing to a decision:
`allowed = (result === true)`. Connectives follow `docs/design/evaluation-model.md`
exactly:

- `or`: any `true` → `true`; all `false` → `false`; else `unknown`
- `and`: any `false` → `false`; all `true` → `true`; else `unknown`
- `not`: flip; `not unknown` → `unknown` (negation never grants on missing data)
- direct relation check: `true`/`false` (a missing edge is `false`, not unknown)
- missing or type-mismatched context attribute: `unknown` (so `not` cannot
  weaponize absent data)
- no candidates for an `indirect` traversal: `false`
- bound exceeded or cycle revisit: `unknown`

`unknown` collapses to DENY, preserving **unknown → deny** (ADR-0006).

### Bounds (default `EvaluationLimits`, all configurable)

| Limit               | Default | Rationale                                                                |
| ------------------- | ------- | ------------------------------------------------------------------------ |
| `maxTraversalDepth` | 10      | ReBAC chains are shallow in practice; deep chains are a DoS/logic hazard |
| `maxVisitedNodes`   | 1000    | Fan-out explosion protection                                             |
| `maxBatchSize`      | 100     | Batch checks cannot bypass per-request bounds                            |

### Cycle handling

A visited-set of `(permission, resourceType, resourceId)` keys during
`indirect` recursion; a revisit contributes `unknown` for that branch. Cycles
terminate paths — never the evaluation, and never with an ALLOW.

### Error taxonomy (matches docs/architecture/failure-modes.md)

1. **Malformed request** (bad identifiers/action) → `ValidationError` thrown
   at the boundary. Caller error; never evaluated.
2. **Infrastructure failure** (policy store / relationship store throws) →
   typed error propagated. Distinct from DENY; the caller chooses its own
   availability behavior.
3. **Defective loaded policy artifact** (fails structural re-check at
   evaluation time) → **DENY** with `reason: "error"` and an `error`
   explanation node. Fail-closed inside the engine.
4. **Normal deny** → `reason: "policy_deny"`; branch matched →
   `"policy_allow"`.

### Determinism & purity

No clock, randomness, network, or I/O. Same (policy version, relationship
state, request, options) → identical decision and identical explanation tree.

### Action → permission mapping

Action `document.read` on resource type `document` → permission `read`
(prefix stripped when it matches the resource type; otherwise the action
string is the permission name).

## Consequences

- Batch checks are sequential in Phase 2 (documented); each item is
  independently fail-closed.
- Every deny is explained; every error path is testable as a security test.
