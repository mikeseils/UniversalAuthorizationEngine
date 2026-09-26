# ADR-0019: Policy version pinning in decisions

Status: **Accepted** (Phase 6)
Closes: the deferral recorded in ADR-0013 ("policy-version pinning belongs with
Phase 6 storage").
Related: ADR-0007 (versioned immutable artifacts), ADR-0010 (fail-closed
semantics), ADR-0016 (SDK outcome taxonomy), ADR-0018 (policy store contract).

## Context

`PolicyStore.getPolicyVersion(version)` has existed since Phase 2, but nothing
in the evaluation path could reach it: `Evaluator.check()` always loaded the
**active** version. That left a gap between what the store could do and what a
decision could cite.

The gap matters because policy versioning exists for four concrete purposes —
auditing, debugging, reproducibility, and rollback — and all four are defeated
if a past decision can only be re-derived by guessing which version was active
at the time. Six months after an incident, "which policy allowed this?" must
have a deterministic answer.

## Decision

### D1 — Pinning is opt-in; the default is unchanged

`CheckOptions.policyVersion?: string`. When omitted, evaluation uses the active
version — exactly the pre-Phase-6 behaviour. This is additive and
backwards-compatible; no existing call site changes meaning.

### D2 — A pinned version is the _only_ version evaluated

When a version is supplied, the evaluator calls `getPolicyVersion(version)` and
uses that artifact. It never consults the active version as a fallback.

### D3 — An unknown version is a caller error, never a fallback

`getPolicyVersion` returning `null` raises `PolicyNotFoundError` (in `@uae/core`).

This is the security-relevant decision, and the reason is worth stating
plainly: **silently falling back to the active version would produce a decision
attributed to a policy that did not produce it.** The result would look
successful, cite a version, and be wrong — corrupting precisely the audit trail
the feature exists to protect. Failing is strictly better than being
plausibly, confidently incorrect.

### D4 — It is a caller error, not `AUTHZ_UNAVAILABLE`

`PolicyNotFoundError` is classified with `ValidationError` as a _caller_ error,
not infrastructure. The SDK transport re-throws it rather than mapping it to
`{ outcome: "unavailable" }`.

The distinction is preserved from ADR-0016: "the version you asked for does not
exist" is a bug in the caller, whereas "the engine could not answer" is an
outage. Collapsing them would make a fail-closed application path mask its own
defect as an infrastructure incident.

### D5 — Every decision cites its version

`AuthorizationDecision.policyVersion` is always populated, whether the version
was pinned or active. It already was; this ADR makes it a guarantee rather than
an observation.

## Consequences

- `authz check --policy-version <v>` and `AuthzClient.check(req, { policyVersion })`
  both reproduce a historical decision. Decision replay (roadmap Phase 36) can
  build on this without inventing a new mechanism.
- The guarantee is one-sided: pinning fixes the _policy_, not the relationship
  state. Replaying a decision months later also requires relationship state as
  it was then, which is a data-retention question, not an evaluation one.
  Recorded here so the limit of the guarantee is not overstated.
- `PolicyNotFoundError` is a new public core export, so it is listed in
  `docs/architecture/api-boundaries.md`.

## Alternatives considered

- **Always evaluate a pinned version.** Rejected: it would make the caller
  responsible for tracking the active version, which is precisely the
  bookkeeping the store exists to do.
- **Fall back to the active version when the pin is unknown.** Rejected for the
  reason in D3 — it produces confidently wrong, wrongly-attributed decisions.
- **Report an unknown version as `unavailable`.** Rejected per D4; it mislabels
  a caller defect as an infrastructure failure.
