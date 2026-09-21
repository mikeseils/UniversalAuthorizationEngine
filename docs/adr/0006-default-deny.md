# ADR-0006: Default-deny and explicit failure semantics

- Status: Accepted
- Date: 2026-09-21
- Context: Governing security invariant for all phases

## Context

The engine is security infrastructure. Undocumented implicit behavior in an
authorization system becomes a vulnerability.

## Decision

The fundamental security model is **unknown → deny**:

1. Any evaluation error (malformed policy, missing relationship data, failed
   attribute provider, evaluator fault) results in **DENY**, never ALLOW.
2. Missing information is never treated as affirmative permission:
   - a missing relationship → that permission branch is not satisfied → DENY
     (unless another branch allows);
   - an unavailable attribute → any condition depending on it evaluates as
     **not satisfied** → DENY;
   - an unknown subject/resource/action → DENY.
3. Infrastructure failure is distinct from denial. SDKs and APIs must
   distinguish `allowed === false` from "authorization service unavailable"
   (see `docs/architecture/failure-modes.md`). Callers decide their own
   fail-open/fail-closed policy; the engine itself is always fail-closed.
4. Any exception to default-deny must be documented in ADRs and tested
   explicitly.

## Consequences

- The evaluator must be deterministic, side-effect free, and incapable of
  granting on error paths. This is a permanent test requirement (see
  `docs/development/testing.md`, security tests).
- Denial results are produced deliberately (a valid, explained DENY), not by
  swallowing errors.
