# ADR-0009: Structured policy representation and validation rules (pre-syntax)

- Status: Accepted
- Date: 2026-09-21
- Context: Phase 2 — the evaluator needs a policy artifact, but the policy
  language syntax is deliberately deferred to Phase 3 (ADR-0008).

## Decision

Phase 2 policies are **structured, versioned, in-memory artifacts**
(`packages/policy`), not text. The compiled artifact shape:

```ts
interface StructuredPolicy {
  definitions: Record<
    typeName,
    {
      relations: Record<relationName, { subjectTypes: string[] }>;
      permissions: Record<permissionName, PolicyExpression>;
      contextSchema?: Record<key, "string" | "number" | "boolean">;
    }
  >;
}

type PolicyExpression =
  | { kind: "relation"; relation } // direct edge
  | { kind: "indirect"; relation; reverse; permission } // ReBAC traversal
  | { kind: "contextEquals"; key; value } // ABAC equality
  | { kind: "and" | "or"; operands }
  | { kind: "not"; operand };
```

Validation (`validateStructuredPolicy`) rejects at publish time: unknown
relation references, empty `and`/`or` operand lists, `contextEquals` on keys
absent from `contextSchema` or with mismatched literal types, and malformed
definitions. `not` outside an `and` operand position produces a **warning**
(negation-based grants are dangerous — see ADR-0010). Publishing compiles the
source to an immutable `VersionedPolicy` with a SHA-256 hash over canonical
(sorted-key) JSON.

## Rationale

- The evaluator consumes compiled artifacts through `PolicyStore`, so the
  Phase 3 syntax decision cannot invalidate the evaluator design
  (requirement 6 of ADR-0008).
- No parser attack surface exists yet; validation is total structural
  checking of typed objects.

## ReBAC traversal mechanism

`{ kind: "indirect", relation, reverse, permission }` evaluates "subject has
`permission` on resource X, where X is linked to the current resource by
`relation`" — `reverse: true` follows `X --relation--> resource` (e.g.
`project:alpha --contains--> document:a` lets a `document` permission walk up
to the containing `project`). Traversal is bounded and cycle-safe (ADR-0010).
This is a minimal, sufficient subset of Zanzibar-style tuple expansion.

## Consequences

- Action naming: an action `document.read` on resource type `document` maps to
  permission `read` (resource-type prefix stripped when present; otherwise the
  action is used verbatim).
- Phase 3 replaces the _source_ representation; `indirect`, `relation`, and
  context conditions carry over as the compiled semantics.
