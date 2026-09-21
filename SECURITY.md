# Security Policy

## Supported status

This project is in early development (Phase 0–1). It is **not yet production
software**; do not use it as your sole authorization layer yet.

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
