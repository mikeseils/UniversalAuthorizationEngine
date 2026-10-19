# ADR-0025: Phase 9 Enterprise Features

- Status: Accepted
- Date: 2026-10-18

## Context

Phase 8 shipped the deployable data plane: signed policy artifacts verified at load (ADR-0024), API-key auth on check endpoints, unauthenticated probes/metrics, request limits (400/413/429), PostgreSQL relationship reads with fail-fast startup, and opt-in rate limiting. The control plane remains the CLI/SDK compile-and-sign pipeline (ADR-0007); there is no hosted control plane and no multi-tenant SaaS.

Roadmap Phase 9 ("Enterprise features") adds: external identity ingestion (SSO/IdP/SCIM — consume identity, never own authentication), policy governance (ownership, review/approval, separation of duties), SCIM provisioning mapping, and compliance exports. Each must update the threat model before implementation (`docs/security/threat-model.md` Process).

## Decision

1. **External identity ingestion.** The engine consumes caller-supplied subject identity; it never authenticates users. Caller-supplied subject/claims enter the check context and are validated against policy-declared schemas at evaluation time; unvalidated or forged claims are rejected (explained DENY / 400), never silently allowed. The data plane authenticates the _caller_ via API key; the caller boundary authenticates the _end subject_. No IdP, SAML, OIDC, LDAP, or user-directory code lives in the engine — adapters are external integration patterns.

2. **Policy governance.** Control plane (CLI + persistence) enforces publication ownership and a review/approval workflow: publish → pending review → approved → activatable. Separation of duties: publisher ≠ approver. Activation records actor, version, and environment in an append-only audit trail. The data plane is unchanged — it verifies signatures only; governance gates occur before an artifact reaches a data plane.

3. **SCIM provisioning mapping.** External identities are mapped to opaque subject IDs and provisioned into the relationship store via operator tooling (idempotent upsert). The engine stores no user profiles, passwords, or groups.

4. **Compliance exports.** Read-only machine-readable evidence exports (decisions, active policy version + hash + keyId, activation history). Exports never contain headers, keys, or request bodies.

## Consequences

- **Positive:** insider policy tampering and external-identity spoofing are mitigated by governance and schema validation; exports give auditors machine-readable evidence.
- **Negative:** adds operational surface (governance keys, approver accounts, SCIM mapping custody, export retention). A determined operator with direct database access can bypass CLI-enforced separation of duties — documented as a deployer responsibility, not an engine guarantee.
- The engine remains **not an authentication provider** (product vision).

## Alternatives considered

- **Hosted control plane / multi-tenant SaaS:** Deferred (ADR-0007; Phase 10+). Phase 9 keeps the control plane local (CLI/persistence).
- **Relationship write API:** Deferred (Phase 10+) — must add authorization, idempotency, and an audit trail before implementation.
- **Engine-owned SSO/OIDC flow:** Rejected — violates "consume identity, never own authentication" and PII minimization (threat-model row 17).

## Related

- ADR-0007: Control plane / data plane trust boundary.
- ADR-0024: Policy artifact signing (data plane verifies; governance gates publishing).
- ADR-0016: SDK design (discrete decision/unavailable outcome).
- `docs/security/threat-model.md`: rows updated for Phase 9.
