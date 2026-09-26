# ADR-0014: Policy test semantics (v1)

- Status: Accepted
- Date: 2026-09-24
- Context: Phase 4 (the `authz test` command). Authorization bugs are security
  bugs, so policy tests are a first-class product feature, not a convenience.

## Decision

Policy tests get their own file grammar, `*.test.authz`, executed by
`authz test`. It is **separate from the policy language** rather than an
extension of it: the policy language stays minimal (ADR-0012's small-surface
principle), while the test grammar reuses the same tokenizer — identifiers,
numbers, strings, `true`/`false`, comments, and precise source positions.

```text
test "owners can write" {
  given {
    user:alice owner project:alpha
  }
  context {
    mfa: true
  }
  check(user:alice, project.write, project:alpha) == allow
}

test "viewers cannot delete" {
  check(user:bob, project.delete, project:alpha) == deny
}

test "a defective policy fails closed" {
  check(user:alice, project.write, project:alpha) == error
}
```

Grammar (v1, normative):

```
testFile     := testBlock*
testBlock    := "test" STRING "{" testItem* "}"
testItem     := givenBlock | contextBlock | assertion
givenBlock   := "given" "{" tuple* "}"
tuple        := ident ":" ident ident ident ":" ident     // subject relation resource
contextBlock := "context" "{" (key ":" literal)* "}"
assertion    := "check" "(" subjectArg "," actionArg "," resourceArg ")" "==" target
target       := "allow" | "deny" | "error"
```

## Semantics (binding)

1. **Assertion targets**
   - `== allow` holds iff `allowed === true`.
   - `== deny` holds iff `allowed === false` **and** `reason === "policy_deny"`.
   - `== error` holds iff `allowed === false` **and** `reason === "error"`.
2. **An `error` outcome can never satisfy `deny`.** This is the most important
   rule here: a malformed policy, a defective artifact, or a bounded/unknown
   evaluation must not masquerade as a passing negative test. Fail-closed
   behavior is asserted _deliberately_, with `== error`.
3. **Isolation.** Each test runs against its own relationship store: the
   baseline tuples from `relationships.jsonl` plus that test's `given` tuples.
   No test can influence another, and execution order cannot change results.
4. **`given` and `context` apply to the whole test** and may appear at most once
   each (a second declaration is an error — no silent accumulation). Both must
   appear before the first assertion; `context` keys must be declared in the
   policy's `contextSchema`, with matching literal types (same rule as the
   language, ADR-0012).
5. **A test with no assertion is an error.** A test that asserts nothing would
   always pass, which is worse than no test.
6. **Determinism.** Tests execute in file order, then source order; files in
   discovery order. No parallelism in v1, so output (and `--json`) is stable.
7. **Failure output explains.** A failing assertion prints the test name, the
   assertion in source form, the actual decision (`allowed`, `reason`,
   `policyVersion`), and the engine's explanation at `standard` level. The
   explanation comes from the same evaluation pass that produced the decision
   (ADR-0011) — the CLI surfaces it, it does not recompute it.
8. **One policy per run.** The policy under test comes from the config/flags,
   never from the test file. Tests describe _behaviour_; they do not mutate or
   select policy versions, which keeps a test run reproducible.

## Rationale

- Reusing the tokenizer keeps one implementation of positions, escapes,
  comments, and number literals, while keeping the policy grammar small enough
  to reason about.
- `== error` as an explicit target is what makes fail-closed behavior testable
  rather than assumed.
- Per-test isolation plus file-order execution makes failures reproducible,
  which matters more than test throughput at this stage.

## Deferred (not in v1)

Invariant/quantified assertions ("viewer can never delete"), generated/fuzzed
cases (Phase 15), policy simulation and diff (`authz diff`), performance
assertions, negative-time/temporal tests, and relationship assertions beyond
`given`. Also deferred: parallel execution and test sharding.
