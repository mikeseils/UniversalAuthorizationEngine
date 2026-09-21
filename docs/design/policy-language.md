# Policy Language

Status: **Deferred decision** — see ADR-0008 for the comparative study and the
binding design requirements. No syntax is final.

## Summary

The policy language will be selected in Phase 3 via ADR. This document records
the **requirements that any candidate must satisfy** and the evaluation
criteria used to choose.

## Binding requirements

1. **Relationship-oriented core.** ReBAC graph traversal is the fundamental
   mechanism; RBAC (roles as relationships) and ABAC (attribute conditions)
   must be expressible within the same model.
2. **Declarative, deterministic, bounded, terminating.** No arbitrary
   computation, side effects, I/O, or unbounded traversal. Think declarative
   query language, not scripting language.
3. **Formally statable semantics.** Exact meaning of `and`, `or`, `not`,
   traversal, and missing information (`unknown → deny`).
4. **Explainable by construction.** Explanations derive from the evaluation
   process itself.
5. **Static-analyzable** (`authz validate`): unreachable permissions,
   contradictions, cycles, unused relations, potential tenant escape,
   unbounded traversal.
6. **Versionable and compilable:** source → parser → validator → compiler →
   immutable artifact with a hash; decisions cite versions.
7. **Small surface.** Every feature must justify its complexity. Features the
   language will _eventually_ consider: `and`/`or`/`not`, attributes,
   conditions, groups/hierarchies, delegation, time restrictions, context —
   **introduced gradually** (see roadmap Phase 13).

## Candidate directions

Sketch under discussion (Zanzibar/OpenFGA-lineage, but ours to shape):

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

Deliberate anti-goals: a general-purpose programming language inside
authorization (no `if`, no external calls, no mutation), and exotic
expressiveness that defeats static analysis.

## Comparative survey

See ADR-0008 (Zanzibar, OpenFGA, SpiceDB, Cedar, OPA/Rego, Oso, Cerbos —
strengths, weaknesses, syntax, expressiveness, evaluation model, performance,
DX, operational complexity).

## Consequence for early implementation

Phases 0–2 use a **structured, versioned in-memory policy artifact** (no
syntax). The evaluator consumes compiled policy through an interface, so the
language choice later does not invalidate the evaluator design.
