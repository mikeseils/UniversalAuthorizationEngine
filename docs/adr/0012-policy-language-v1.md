# ADR-0012: Policy language v1 — a small declarative ReBAC syntax

- Status: Accepted
- Date: 2026-09-21
- Context: Phase 3 (extends ADR-0008's requirements; replaces the "decision
  deferred" stance for v1)

## Decision

Adopt a small, declarative, ReBAC-oriented text syntax in the
Zanzibar/OpenFGA lineage, **adapted to the compiled semantics** already
implemented in Phase 2 (ADR-0009/0010). The language is a surface for
`StructuredPolicy`, nothing more: no computation, no escape hatches.

```
definition organization {
  relation admin: user
  relation member: user

  permission manage = admin
  permission read = admin or member
}

definition project {
  relation organization: organization via owns
  relation owner: user
  relation editor: user
  relation viewer: user

  permission read =
    viewer or editor or owner
    or organization.read
  permission write = editor or owner
  permission delete = owner or organization.manage
}

definition document {
  relation project: project via contains
  permission read = project.read
  permission delete = project.delete
}

definition invoice {
  context mfa: boolean
  relation approver: user
  permission approve = approver and context.mfa == true
}
```

## Grammar (v1, normative)

```
policy         := definition+
definition     := "definition" NAME "{" item* "}"
item           := relationDecl | contextDecl | permissionDecl
relationDecl   := "relation" NAME ":" NAME ("," NAME)* ("via" NAME)?
contextDecl    := "context" NAME ":" ("string" | "number" | "boolean")
permissionDecl := "permission" NAME "=" expression
expression     := orExpr
orExpr         := andExpr ("or" andExpr)*        // lowest precedence
andExpr        := primary ("and" primary)*
primary        := NAME                            // relation reference
                | NAME "." NAME                   // target-type permission
                | "context" "." NAME "==" literal
                | "(" expression ")"
literal        := "true" | "false" | NUMBER | STRING
```

Comments: `//` to end of line and `/* ... */`. `NAME` is
`[a-zA-Z_][a-zA-Z0-9_]*`; keywords are lowercase and reserved. Source input is
capped (256 KB) and parsing is recursive descent without backtracking —
guaranteed termination.

## Decisions on the open questions

1. **Traversal syntax**: `targetType.permission` inside a definition. The
   traversal edge is derived from the definition's relation declarations
   (binding, see below). No arrows, no `reverse` keyword.
2. **Direction inference via declarations, not guessing**:
   - `relation organization: organization` — an _outgoing_ edge
     (`resource --organization--> target`). `organization.read` lowers to
     `indirect(relation: "organization", reverse: false, permission: "read")`.
   - `relation project: project via contains` — an _incoming_ edge
     (`target --contains--> resource`). `project.read` lowers to
     `indirect(relation: "contains", reverse: true, permission: "read")`.
     This is statically type-checkable and avoids direction bugs at authoring
     time. Ambiguity (two outgoing relations with the same target type, or two
     incoming `via` edges into the same target type) is a **validation error**.
3. **Context conditions**: `context.<key> == <literal>` only, keys must be
   declared in the definition's `contextSchema` (equality only; comparisons
   deferred). Missing data is `unknown` → deny (ADR-0010) — unchanged.
4. **`not` is excluded from source v1.** It remains valid in the compiled
   representation (Phase 2 behavior unchanged), but authors cannot write it
   until static analysis can guard negation grants. Phase 2's validator
   warning becomes unreachable for text policies.
5. **Bare identifiers refer to relations only** — no permission-to-permission
   composition in v1 (keeps evaluation semantics minimal; revisit later).

## Rationale (vs alternatives)

- **OpenFGA-like** (adopted base): ReBAC-native, familiar shape, maps 1:1 to
  our compiled semantics. Differences: no `but not`, no direct-tupleset
  syntax — our `via` declarations cover it with explicit typing.
- **Cedar-like attribute algebra**: rejected — attribute-centric, richer
  expression grammar than our bounded semantics support; wrong fit for a
  graph-first engine.
- **OPA/Rego**: rejected — a programming language; violates ADR-0008
  requirements 2 and 7.
- **YAML/JSON policies**: viable but poor readability for permissions and no
  room for a future compiled DSL; revisit for machine-generated policies.

## Consequences

- Parser, AST, lowering, and validation live in `@uae/policy`; the evaluator
  is untouched — it keeps consuming `CompiledPolicyArtifact` through
  `PolicyStore` (the interface boundary that made this cheap).
- `InMemoryPolicyStore.publishPolicy` accepts text or structured source;
  text is parsed → lowered → validated → compiled → versioned.
- Cross-representation equivalence is a permanent test requirement: the Acme
  text policy must produce identical decisions (`allowed` + `reason`) for every
  check covered by the programmatic Acme policy. Explanation tree _shape_ may
  differ (e.g. a one-operand `anyOf` wrapper), so equivalence is asserted on
  decisions, while explanation behavior is tested directly against the text
  policy.
- Remaining deferred (roadmap Phase 13+): comparisons beyond equality,
  arithmetic, functions, time intervals, permission composition, `not`.
