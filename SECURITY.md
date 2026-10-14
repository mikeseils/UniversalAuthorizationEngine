# Security Policy

## Supported status

Phases 0–6 of the roadmap are **implemented** (domain model, in-memory
evaluator, policy language, CLI, TypeScript SDK, PostgreSQL persistence) and
Phase 7 (performance — version-keyed decision, policy, and relationship
caching) is **in progress**.

The engine is usable **embedded** in a TypeScript/Node application today:
fail-closed evaluation (ADR-0006), immutable versioned policy artifacts,
adversarial security tests, and PostgreSQL-backed stores validated against a
live database in CI. What does **not** yet exist is a deployable
authorization _service_ — the network data plane, control-plane
authentication, policy artifact signing, deployment tooling, and
observability are Phase 8 and unbuilt, and relationship writes are not yet
authorized mutations (threat model rows 1–2).

Until those land, do **not** use this project as your sole authorization
layer; embed it only after your own review of the deployment, backup, and
monitoring responsibilities you inherit. Note also that public API shapes
outside `@uae/sdk` remain draft
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
