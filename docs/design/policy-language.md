# Policy Language

Status: **Decided (v1) and implemented** — see `../adr/0012-policy-language-v1.md`
for the normative grammar, the decisions taken, and the rationale. ADR-0008
records the comparative study behind the requirements below.

## Summary

The language is a small, declarative, ReBAC-oriented text syntax in the
Zanzibar/OpenFGA lineage, shaped to compile onto the semantics already
implemented in Phase 2. It is a **surface for the structured representation**:
the parser produces an AST, lowering resolves it to `StructuredPolicy`, and the
existing compiler/validator/evaluator are unchanged.

Implemented in `@uae/policy` (Phase 3): `lexer` → `parser` → `ast` → `lower`
(with `source` as the pipeline entry point), plus `InMemoryPolicyStore` accepting
text or structured source through one publish path. The evaluator never sees
text.

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

## Language v1

```
definition organization {
  relation admin: user
  relation member: user

  permission manage = admin
  permission read = admin or member
}

definition project {
  relation organization: organization via owns   // incoming edge
  relation owner: user
  relation editor: user
  relation viewer: user

  permission read = viewer or editor or owner or organization.read
  permission write = editor or owner
  permission delete = owner or organization.manage
}

definition invoice {
  context mfa: boolean
  relation approver: user
  permission approve = approver and context.mfa == true
}
```

Constructs: `definition`, `relation NAME: TYPE[, TYPE...]` with an optional
`via EDGE` (incoming edge), `context NAME: string|number|boolean`, and
`permission NAME = expression` where an expression is built from relation
references, `targetType.permission` traversals, `context.key == literal`, and
`and`/`or`/parentheses. Comments `//` and `/* ... */`. Source is capped at
256 KB and parsing is recursive descent without backtracking.

Deliberate anti-goals: a general-purpose programming language inside
authorization (no `if`, no external calls, no mutation), and exotic
expressiveness that defeats static analysis.

## Deferred (deliberately absent from v1)

`not` in source (valid only in the compiled representation until static
analysis can guard negation grants), comparisons beyond equality, arithmetic,
functions, time/interval syntax, permission-to-permission composition,
imports/packages, and a machine-generated (JSON/YAML) surface.

## Comparative survey

See ADR-0008 (Zanzibar, OpenFGA, SpiceDB, Cedar, OPA/Rego, Oso, Cerbos —
strengths, weaknesses, syntax, expressiveness, evaluation model, performance,
DX, operational complexity).

## Consequence for early implementation

Phases 0–2 use a **structured, versioned in-memory policy artifact** (no
syntax). The evaluator consumes compiled policy artifacts through an interface,
so the language choice did not invalidate the evaluator design — Phase 3 added
the text surface, AST, lowering, and validation without changing the evaluator,
the store interface, or the decision semantics.
