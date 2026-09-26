# ADR-0016: TypeScript SDK design and outcome taxonomy

- Status: Accepted
- Date: 2026-09-25
- Context: Phase 5 (implements `@uae/sdk` per ADR-0005 and ADR-0007).

## Decision

The TypeScript SDK provides the stable client surface for application developers
to evaluate authorization questions against the engine.

### 1. Structural separation of DECISION vs UNAVAILABLE

A denial (`allowed: false`) and an infrastructure failure (`AUTHZ_UNAVAILABLE`)
are fundamentally different outcomes (`docs/architecture/failure-modes.md`).
The SDK represents this separation **structurally**, not by exception catch-blocks:

```ts
export interface AuthorizationDecisionOutcome {
  readonly outcome: "decision";
  readonly decision: AuthorizationDecision;
}

export interface AuthorizationUnavailableOutcome {
  readonly outcome: "unavailable";
  readonly error: AuthorizationUnavailableError;
}

export type CheckOutcome = AuthorizationDecisionOutcome | AuthorizationUnavailableOutcome;
```

Callers handle both cases explicitly:

```ts
const result = await client.check(request);
switch (result.outcome) {
  case "decision":
    if (!result.decision.allowed) throw new ForbiddenError();
    break;
  case "unavailable":
    // Engine could not answer; caller decides application policy
    break;
}
```

### 2. Guarded helper: `isAllowed`

For common boolean authorization guards, `client.isAllowed(request, options)` is provided:

- If `outcome === "decision"`, returns `result.decision.allowed`.
- If `outcome === "unavailable"`:
  - Default: **throws** `AuthorizationUnavailableError`. Callers are forced to handle
    engine outages and cannot accidentally treat an outage as an answer.
  - Opt-in fallback: `{ onUnavailable: "deny" }` returns `false` (fail-closed).
  - **No option to fail open exists.** The SDK deliberately provides no configuration
    or parameter that turns unavailability into `true`.

### 3. Per-item batch isolation: `checkBatch`

`client.checkBatch(requests, options)` evaluates multiple requests up to `maxBatchSize`.

- Each element in the returned array is an independent `CheckOutcome`.
- If an individual evaluation fails due to an infrastructure or lookup failure, that item
  yields `{ outcome: "unavailable", error }` without discarding companion items or
  fabricating decisions.
- If the batch size exceeds `maxBatchSize` or any request has malformed inputs, a typed
  `ValidationError` rejects the entire batch at the boundary.

### 4. Transport abstraction

`AuthzClient` delegates evaluation to a `ClientTransport` interface:

- `InProcessTransport` (default): wraps an in-process `Evaluator` instance.
- Network/HTTP/gRPC transport (Phase 8): implements the exact same interface across
  a network boundary without altering client semantics.

### 5. Factories for high developer ergonomics

- `AuthzClient.fromEvaluator(evaluator: Evaluator): AuthzClient`
- `AuthzClient.inMemory(options: InMemoryClientOptions): Promise<AuthzClient>`
  Instantiates an in-memory policy store, relationship store, and evaluator from
  source or file paths.

## Consequences

- Applications cannot conflate denials with outages.
- Clear migration path to distributed/networked deployments without breaking client code.
