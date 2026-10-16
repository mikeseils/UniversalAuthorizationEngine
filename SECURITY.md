# Security Policy

## Supported status

Phases 0–8 of the roadmap are **implemented** (domain model, in-memory
evaluator, policy language, CLI, TypeScript SDK, PostgreSQL persistence, the
Phase 7 performance work, and the Phase 8 production architecture — Ed25519
policy artifact signing, the HTTP data plane with API-key authentication,
structured logging and Prometheus metrics, Docker deployment, and the
disaster-recovery runbook).

The engine is usable **embedded** in a TypeScript/Node application today and
as a **self-hosted data-plane service**: fail-closed evaluation (ADR-0006),
immutable versioned policy artifacts verified by signature at load time
(ADR-0024), adversarial security tests, PostgreSQL-backed stores validated
against a live database in CI, and a container image smoke-tested in CI for
boot, the auth gate, and fail-closed behavior. What does **not** yet exist:
relationship writes are not yet authorized mutations and the deployed data
plane has no relationship ingestion path yet (threat model rows 1–2); there
is no hosted control-plane service (the control plane is the CLI/SDK
compile-and-sign pipeline); and TLS termination, rate limiting, and API-key
rotation remain the deployer's responsibility at the service boundary.

Do **not** use this project as your sole authorization layer until the open
items above land; embed it only after your own review of the deployment,
backup, and monitoring responsibilities you inherit. Note also that public
API shapes outside `@uae/sdk` remain draft
(`docs/architecture/api-boundaries.md`), so only the SDK surface carries a
stability commitment.

## Reporting a vulnerability

Do **not** open a public issue for security vulnerabilities.

Report via GitHub private security advisory ("Report a vulnerability" on the
Security tab) or contact the maintainers directly. Include: description,
impact, reproduction steps, and any suggested mitigation. You can expect an
initial response within 7 days.

## Security-relevant design rules reviewers must enforce

- **Unknown → deny** (ADR-0006): every error path denies.
- DENY is distinct from infrastructure unavailability.
- Malformed input is rejected at the boundary, never coerced.
- Tenant isolation invariants are tested adversarially.
- Bounded evaluation: depth/fan-out/size limits; cycles terminate.
- Policies are immutable, versioned artifacts; decisions cite versions.

See `docs/security/threat-model.md` and `docs/security/security-principles.md`.

## Secret hygiene

Never commit `.env*`, credentials, API keys, tokens, or private certificates.
`.gitignore` blocks these by default.
