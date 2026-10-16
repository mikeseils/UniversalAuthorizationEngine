# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security vulnerabilities.

Report via GitHub private security advisory ("Report a vulnerability" on the
Security tab) or contact the maintainers directly. Include: description,
impact, reproduction steps, and any suggested mitigation. You can expect an
initial response within 7 days.

## What this project is

A self-hosted authorization engine shipped two ways:

- **Embedded library** (`@uae/sdk` over `@uae/evaluator`): your TypeScript/Node
  application evaluates policies in-process.
- **Self-hosted data-plane service** (`@uae/data-plane` container image):
  your services call `POST /check` / `POST /checkBatch` over HTTP.

There is no hosted SaaS and no multi-tenant control plane. The control
plane is the CLI/SDK pipeline you run yourself: compile a policy, sign the
artifact, hand the artifact file to the data plane. Only the `@uae/sdk`
surface carries a stability commitment
(`docs/architecture/api-boundaries.md`); do not build security assumptions
on internal package APIs.

## Evaluation guarantees (both distributions)

- **Default deny.** `unknown → deny` (ADR-0006). Missing relationships,
  unavailable attributes, and evaluation errors never produce ALLOW.
- **DENY is distinct from infrastructure failure.** A policy decision against
  access returns DENY; a store outage, missing artifact, or unavailable
  database returns a typed `AUTHZ_UNAVAILABLE` (HTTP 503). Applications
  choose their availability behavior explicitly — the engine never upgrades
  an outage into a decision.
- **Bounded execution.** Traversal depth/fan-out, request and batch sizes,
  and policy source size are capped; pathological input degrades to an
  explained DENY, and cyclic graphs terminate (branch `unknown` ⇒ deny).
- **Tenant isolation.** Relationships and policies are tenant-scoped;
  cross-tenant access requires explicit, auditable policy support. Covered
  by adversarial tests (`tests/security-*.test.ts`).
- **Immutable, versioned policies.** Decisions cite the exact policy version
  they were evaluated under. There is no silent policy mutation and no hot
  reload: changing the artifact requires a restart (rolling restart, or one
  image tag per artifact); `GET /version` reports what a node is serving.

## Data-plane authentication and request handling

- **API keys** (`UAE_API_KEYS`): accepted as `Authorization: Bearer <key>`
  or `X-API-Key: <key>` on every endpoint **except** `GET /healthz`. Missing
  or invalid key → **401**. Unset/empty key list means **dev mode** (no
  auth, every request accepted) — never run dev mode outside local dev.
- **Probes and metrics are unauthenticated by design.** `GET /healthz` and
  `GET /metrics` accept no key. Serve them on a private network only; do
  not expose them through a public load balancer
  (`docs/operations/deployment.md`).
- **Request limits.** Malformed JSON → **400**, body over
  `UAE_MAX_BODY_BYTES` (default 1 MiB) → **413**, beyond the opt-in per-key
  fixed-window rate limit (`UAE_RATE_LIMIT_PER_MINUTE`, 0 = disabled) →
  **429**. Keep edge rate limits in place too: the edge sees client sources
  the server buckets as one.
- **No TLS in the service.** Terminate TLS at your load balancer / ingress
  and keep LB → data plane → PostgreSQL traffic on a private network.
- **Logs are safe to ship.** One JSON object per line with method, path,
  status, duration, and outcome only — no headers, keys, or request bodies.

## Policy supply chain

- Artifacts are versioned JSON carrying `{ artifact, hash }` plus an Ed25519
  signature (`keyId`, algorithm recorded on the artifact, ADR-0024). The
  data-plane loader verifies against your `keyId → PEM` map
  (`UAE_PUBLIC_KEYS_PATH`); `UAE_REQUIRE_SIGNATURE=true` rejects unsigned
  artifacts at startup, fail-closed. A compromised artifact pipeline cannot
  push an unverifiable artifact to a verifying data plane.
- Mount artifacts read-only. Guard the **private signing keys** the way you
  guard any code-signing keys: never in the repo, image, or `.env` file.
  Key-compromise rotation is covered in
  `docs/operations/disaster-recovery.md`.

## Relationship data

- The deployed data plane serves relationship **reads** from PostgreSQL
  (`UAE_PG_URL`; optional `UAE_RUN_MIGRATIONS=true` applies the bundled
  idempotent migrations). If the database is unreachable at startup, the
  entrypoint logs `startup_failed` and exits non-zero — it never silently
  falls back to an empty store. Without `UAE_PG_URL` the store is empty
  in-memory and relationship-dependent checks fail closed.
- **There is no HTTP relationship-write API.** Mutations are operator
  actions against the authenticated database, so database credentials,
  network ACLs, and backups are deployer responsibilities (see
  `docs/operations/deployment.md` and the disaster-recovery runbook).

## Deployer responsibilities (what you inherit)

Running this service means you own: TLS termination and private networking;
long random API keys from a secret manager plus zero-downtime rotation (add
new key → roll → confirm migration → remove old key; multiple keys are
accepted concurrently); PostgreSQL authentication, network policy, backups,
and restore drills; artifact and signing-key custody; edge rate limiting;
and monitoring/alerting on `/metrics` (`uae_checks_*`,
`uae_rate_limited_total`) and the JSON logs. Review these, plus the backup
and monitoring duties, before relying on this project as an authorization
layer.

## Secret hygiene

Never commit `.env*`, credentials, API keys, tokens, or private
certificates. `.gitignore` blocks these by default; `.env.example` shows
placeholders only.

## Future work with security implications

The roadmap's planned enterprise and longer-horizon work touches this policy
where noted — each item must update the threat model before implementation:

- **Policy governance** (ownership, review/approval workflow, separation of
  duties): adds publication authorization the engine does not enforce today.
- **External identity** (SSO/IdP consumption, SCIM provisioning): the engine
  will consume caller-supplied subject identity, never own authentication
  — the caller boundary stays responsible for authenticating subjects and
  validating context against policy-declared schemas.
- **Relationship mutation surface** (authorized write API, event-driven
  sync, database-aware predicates): must add authorization, idempotency,
  and an audit trail; until then, writes stay operator-only per above.
- **Distributed and edge execution** (consistency-model choices,
  multi-region, offline): new staleness and revocation-lag trade-offs to
  decide explicitly; scoped cache invalidation remains an open hit-rate
  problem (never a safety problem — version-keyed invalidation is always
  safe).

## Security-relevant design rules reviewers must enforce

- Unknown → deny; every error path denies or fails closed (503).
- DENY is distinct from infrastructure unavailability.
- Malformed input is rejected at the boundary (400/413), never coerced.
- Tenant isolation invariants are tested adversarially.
- Bounded evaluation: depth/fan-out/size limits; cycles terminate.
- Policies are immutable, versioned artifacts; decisions cite versions.

See `docs/security/threat-model.md` and
`docs/security/security-principles.md`.
