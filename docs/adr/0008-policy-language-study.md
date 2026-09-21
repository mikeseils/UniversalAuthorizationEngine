# ADR-0008: Policy language — comparative study (decision deferred)

- Status: Accepted (decision deliberately deferred to Phase 3)
- Date: 2026-09-21

## Context

The engine needs a small, readable, formally understandable policy language,
but committing to a syntax before studying prior art risks locking in the wrong
expressiveness/complexity trade-off.

## Decision

**Do not select a final policy language now.** Perform a comparative study,
document requirements, and choose in a Phase 3 ADR. This ADR records the study
and the design constraints the eventual language must satisfy.

## Prior art survey

| System              | Approach                                                               | Strengths                                                                                 | Weaknesses                                                                                                            |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Google Zanzibar** | Relationship graph + rewrite rules (namespaces, tuple usersets)        | Proven at planet scale; ReBAC-native; consistent snapshot semantics                       | Complex; rewrite rules are hard for developers to read; relies on global infrastructure (lease/snowflake timing)      |
| **OpenFGA**         | Zanzibar-inspired DSL (`definition`, `relation`, tupleset indirection) | Developer-friendly Zanzibar; good tooling                                                 | Traversal-based evaluation can be slow on deep graphs; limited condition expressiveness                               |
| **SpiceDB**         | Zanzibar-inspired schema language + caveats                            | Strong consistency options, caveats (context conditions), performance focus               | Operational complexity of the cluster; schema can grow opaque                                                         |
| **Cedar** (AWS)     | Formal, verified attribute/role language                               | Formal semantics + proofs; deterministic; excellent static analysis; great error messages | Not relationship-graph-native; attribute-centric modeling is a different fit; verification story is hard to replicate |
| **OPA / Rego**      | General-purpose policy-as-data (Datalog-derived)                       | Extremely expressive; infrastructure-policy breadth                                       | Rego is a programming language in practice — hard to audit, unbounded evaluation risk, poor authorization-specific DX |
| **Oso**             | Embedded library, polar logic language                                 | Great in-app DX; roles helpers                                                            | Host-language coupling; less suited to hosted/centralized deployments                                                 |
| **Cerbos**          | Per-request policy YAML/conditions                                     | Simple; good DX for API filtering (PDP)                                                   | Less natural for rich ReBAC graphs; model is rule-per-action                                                          |

## Requirements for our language (binding on the Phase 3 decision)

1. **Relationship-oriented core** (ReBAC graph as the fundamental
   representation) with roles (RBAC) and attribute conditions (ABAC) expressible
   without escaping the model.
2. **Declarative, deterministic, bounded, terminating** — no arbitrary
   computation, I/O, or unbounded traversal. A declarative query language, not
   a scripting language.
3. **Formally statable semantics** — `or`, `and`, `not`, missing-data behavior,
   and traversal order are exactly defined (see `evaluation-model.md`).
4. **Explainable by construction** — explanations are generated from the same
   evaluation process as the decision (no separate approximate explainer).
5. **Static-analyzable** — reachability, contradictions, tenant escape, and
   unbounded traversal detectable before deployment (`authz validate`).
6. **Versionable and compilable** — source → parser → validator → compiler →
   immutable artifact; decisions cite artifact versions.
7. **Small surface** — resist building a programming language. Features earn
   their complexity.

## Sketch (for discussion only, not a decision)

```
definition organization {
    relation member: user
    relation admin: user
}

definition project {
    relation organization: organization
    relation owner: user
    relation editor: user
    relation viewer: user

    permission read  = viewer or editor or owner
    permission write = editor or owner
}
```

The example above resembles OpenFGA; the final syntax may differ. The decision
will weigh the requirements above against developer familiarity.

## Consequences

- Phase 0–2 implementation must not hard-code a syntax; policy representation
  starts as a versioned, structured (in-memory) artifact.
