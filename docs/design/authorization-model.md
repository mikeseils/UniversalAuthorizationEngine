# Authorization Model

Status: **Planned** for implementation (Phase 2+); the model design below is
the binding direction.

## One model, three classical styles

The engine supports RBAC, ABAC, and ReBAC — but **not as three separate
systems**. The fundamental representation is a **relationship-oriented graph**
(ReBAC), with roles and attributes expressible within it:

### RBAC — roles are relationships

```
Alice → member of → role:editor → grants → project.write
```

A role is just a resource type (`role:editor`) that policies use to grant
permissions. No special role machinery in the core.

### ABAC — conditions on attributes

```
department == "finance"
AND resource.type == "invoice"
AND resource.amount < 10000
```

Attributes arrive from **explicit, controlled providers** (subject attributes,
resource attributes, context) — never arbitrary code (roadmap: extensibility
without arbitrary code). Unavailable attributes make conditions unsatisfied
(default-deny, ADR-0006).

### ReBAC — the graph

```
Alice → member → Acme → owns → Project 123 → contains → Document 456
```

Permission on Document 456 follows traversal defined by policy
(`document.read = viewer or editor or owner`, where viewer/editor/owner are
defined against the containing project, etc.).

## Decision procedure (conceptual)

```
CheckRequest
    ↓ Normalize            (parse & validate identifiers, context)
    ↓ Load relevant policy  (exact version via PolicyStore)
    ↓ Resolve relationships (bounded traversal via RelationshipStore)
    ↓ Evaluate conditions   (deterministic, side-effect free)
    ↓ Produce decision       (ALLOW | DENY — never "maybe")
    ↓ Produce explanation    (optional, same process as decision)
```

Binding rules:

- **Deterministic**: same inputs (policy version + relationships + context) →
  same decision and same explanation, always.
- **Side-effect free**: no network access, DB writes, or logging inside
  evaluation. External state arrives only through explicit store/provider
  interfaces.
- **Default deny** (ADR-0006): unknown or errored → DENY. Denial is an
  explained result, not an exception.
- **Bounded traversal**: graph depth/width limits; pathological graphs
  (cycles) are handled safely, not by infinite loops (threat model).

## What the answer looks like

```ts
interface AuthorizationDecision {
  allowed: boolean;
  explanation?: AuthorizationExplanation; // optional, detail-leveled
  policyVersion?: string; // exact policy artifact version
}
```

These shapes are documented but **non-final** (see `evaluation-model.md` § API
stability). No public API is stabilized before the design reasoning is
recorded in an ADR.

## Explicitly deferred

- `listAuthorized()` — until the authorization and storage models support it
  correctly (it is architecturally anticipated: decision caching and the
  "list problem" predicate design).
- Temporal relationships, delegation constraints, consistency modes,
  database predicates — designed in the roadmap phases, not implemented.
