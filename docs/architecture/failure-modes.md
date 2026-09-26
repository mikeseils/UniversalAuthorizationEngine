# Failure Modes

Status: **Binding design.** Fail-closed is invariant from day one (ADR-0006).

## The core rule

> Any evaluation failure must not silently become an authorization success.

## Failure taxonomy

| Failure                                          | Behavior                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Malformed request (bad identifiers/context)      | Rejected at the boundary; caller error; never evaluated                                                            |
| Malformed policy                                 | Policy fails validation at publish time; never loaded. A defective loaded artifact ⇒ DENY + error explanation node |
| Missing relationship data                        | Required branch unsatisfied ⇒ DENY (explained)                                                                     |
| Attribute provider failure/unavailable attribute | Condition unsatisfied ⇒ DENY (explained); provider errors are recorded, not swallowed                              |
| Traversal bound exceeded / cycle                 | Path terminates ⇒ that branch `unknown` ⇒ DENY (explained)                                                         |
| Evaluator internal error                         | DENY (or typed infrastructure error), with an error explanation node; never ALLOW                                  |
| Policy store unavailable                         | Typed infrastructure failure — distinct from DENY (see below)                                                      |
| Relationship store unavailable                   | Typed infrastructure failure — distinct from DENY                                                                  |
| Batch larger than `maxBatchSize`                 | Rejected at the boundary (typed `ValidationError`) before any evaluation                                           |
| Infrastructure failure during a batch            | The whole batch rejects — per-item outcomes are never fabricated (the SDK represents unavailability per item)      |

## DENIED vs AUTHZ_UNAVAILABLE

A denial and an infrastructure failure are **fundamentally different
outcomes**, and SDKs/APIs must not conflate them. They are separated
_structurally_ — never by convention — so that no caller can accidentally treat
"could not answer" as an answer:

```ts
const result = await authz.check(req);

switch (result.outcome) {
  case "decision":
    // The engine answered; the decision is authoritative.
    if (!result.decision.allowed) throw new ForbiddenError(); // legitimate DENY
    break;
  case "unavailable":
    // AUTHZ_UNAVAILABLE — the engine could not answer. The caller decides its own
    // fail-open/fail-closed policy for its domain (a payment system denies;
    // a social feed may tolerate cached decisions). The engine never fabricates
    // a decision for this case.
    break;
}
```

An earlier revision of this document illustrated the distinction with
`authz.check()` inside a `try` and a `ForbiddenError` throw inside that same
`try`. That form is wrong: the `catch` cannot distinguish a thrown DENY from an
AUTHZ_UNAVAILABLE, so both collapse into one branch — exactly the conflation
this section forbids.

The engine itself is always fail-closed. Making availability behaviour explicit
at the _application_ level is the SDK's job (ADR-0016), and the SDK deliberately
offers **no** option that turns unavailability into an ALLOW; a caller that
wants deny-on-unavailable asks for it explicitly.

## Availability design (deferred implementation, binding direction)

- Replicated policy storage; retained policy artifacts; tested disaster
  recovery; documented consistency behavior.
- Data-plane nodes run on their current immutable policy artifact — losing
  control-plane contact degrades _policy freshness_, not decision ability.
- Every mutation endpoint is idempotent (networks fail; retried relationship
  writes must not duplicate or corrupt state).

## Exhaustion & abuse (see threat model)

Request size limits, batch limits, traversal bounds, and rate limiting are
security controls, not performance tuning: unbounded evaluation is a
denial-of-service vector and a complexity-driven correctness hazard.
