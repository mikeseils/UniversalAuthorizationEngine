# ADR-0011: Explanation generation and disclosure levels

- Status: Accepted
- Date: 2026-09-21

## Decision

Explanations are produced **during** the evaluation pass — each expression
node evaluation returns both its truth value and its `ExplanationNode` — so an
explanation can never disagree with the decision (no separate explainer).

### Detail levels

Explanations are requested per check via `check(request, { explanation })`;
the default is `"none"` (no leakage by default). Pruning happens **after**
full evaluation, so the requested level can never change the decision.

| Level      | Content                                                        |
| ---------- | -------------------------------------------------------------- |
| `none`     | No explanation (default)                                       |
| `minimal`  | Root node only (e.g. "document.read → DENY")                   |
| `standard` | Full tree with `skipped` branches pruned                       |
| `debug`    | Full tree including skipped branches and bound/error internals |

### Rules

1. Root node describes the requested action and carries the final outcome.
2. `relation` nodes render as `subject --relation--> resource`.
3. `indirect` nodes record the traversal edge and nested permission.
4. `condition` nodes render as `context.<key> == <value>`.
5. Errors and bound-limit hits appear as `error`/`bound` nodes with
   `outcome: "unknown"` — a caller can always ask _why_ and see that
   evaluation was cut short (default-deny visibility).
6. Determinism: identical inputs → identical trees (tested).
7. Disclosure of `standard`/`debug` to end users is an application-level
   authorization decision; the engine exposes the levels but does not decide
   who may see them.

## Consequences

- Explanation construction adds no I/O and no nondeterminism.
- Phase 2 tests enforce: decision/explanation agreement on every case, level
  pruning safety, and tree determinism.
