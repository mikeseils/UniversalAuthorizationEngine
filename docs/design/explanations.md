# Explanations

Status: **Design** — implementation with the evaluator (Phase 2/4).

Explanations are a **first-class product feature** and arguably the killer
feature: the engine answers _why was this allowed?_ / _why was this denied?_

## Examples

ALLOW:

```
ALLOW document:a read

document.read
└── project.viewer (on project:alpha)
    └── project:alpha --viewer-- user:alice ✓
```

DENY:

```
DENY document:a delete

document.delete
└── requires project.admin
    └── project:alpha --admin-- user:alice ✗ not found
        (no other branch matched)
```

Graph-flavored, human-readable summary:

```
Alice → viewer of → Project Alpha → contains → Document A
Policy: project viewers may read documents → ALLOW
```

## Binding design rules

1. **Explanations come from the same evaluation pass as the decision.** Never
   a separate, approximate "explanation engine" that could disagree with the
   actual result.
2. **Deterministic**: same inputs → identical explanation.
3. **Information disclosure is controlled.** Explanations can leak sensitive
   policy structure (e.g., revealing that a super-admin role exists, or the
   shape of anti-fraud rules). Therefore explanations support **detail
   levels**:

   | Level      | Audience                          | Content                                                                       |
   | ---------- | --------------------------------- | ----------------------------------------------------------------------------- |
   | `none`     | default                           | No explanation data                                                           |
   | `minimal`  | any authorized caller             | Decision path summary, no policy internals                                    |
   | `standard` | developers/ops                    | Matched/failed branches, relations traversed                                  |
   | `debug`    | policy authors, controlled access | Full evaluation trace, including failed branches against all considered edges |

   Access to higher detail levels is itself an authorization decision (caller
   permission + configuration), enforced outside the evaluator core.

4. **Audit linkage**: every persisted decision record references
   `decision_id`, `policy_version`, and (optionally) the relationships that
   determined the outcome — provenance for compliance and incident response
   (roadmap Phase 35/36).

## Explanation node model (sketch)

```
ExplanationNode {
  kind:        "permission" | "relation" | "condition" | "error" | "bound"
  description: string
  outcome:     "matched" | "not_matched" | "unknown" | "skipped"
  children?:   ExplanationNode[]
}
```

Errors and bound-limit hits appear as nodes with `outcome: "unknown"`,
preserving default-deny visibility: a user can always ask _why_ and see
"evaluation stopped: relationship depth bound exceeded."

## Testing

Explanation determinism and default-deny behavior get dedicated tests
(Phase 2): identical inputs → identical explanation trees; error paths
produce explained DENYs; disclosure levels are unit-tested for leakage.
