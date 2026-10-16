# Deployment

Status: implemented (Phase 8). This is the operations companion to the
`Dockerfile`, `docker-compose.yml`, and `packages/data-plane/bin/start.js`
in this repository; disaster recovery is covered separately in
`disaster-recovery.md`.

## What ships

- **Image**: multi-stage build; CI builds it, smoke-tests boot, the auth
  gate, and fail-closed behavior, and publishes
  `ghcr.io/<owner>/<repo>/data-plane:{sha,main}` from `main`. The container
  runs as the unprivileged `node` user.
- **Reference deployment**: `docker compose up` starts PostgreSQL and the
  data plane (health-gated ordering, persistent `pgdata` volume).

## Service boundary responsibilities (deployer)

The data plane deliberately terminates **no TLS** and owns **no user
directory**:

- **TLS**: terminate TLS at your load balancer / ingress. Keep internal
  traffic (LB → data plane, data plane → PostgreSQL) on a private network.
- **Metrics**: scrape `/metrics` over the private network only. It is
  intentionally unauthenticated (as is `/healthz`); do not expose either
  through a public load balancer.
- **API keys** (`UAE_API_KEYS`): long random values from your secret
  manager — never baked into the image. Rotation is zero-downtime because
  multiple keys are accepted concurrently: add the new key, roll the
  deployment, confirm clients migrated, remove the old key.
- **Rate limiting**: the server enforces an in-process fixed-window limit
  (`UAE_RATE_LIMIT_PER_MINUTE`, per API key — per client address in dev
  mode) as defense in depth. Keep edge rate limits too: the edge sees
  sources the server buckets as one.
- **Policy artifacts**: mount read-only. There is no hot reload — updating
  an artifact requires a restart (rolling restart, or bake an image tag per
  artifact). `GET /version` reports what a node is actually serving.
- **Relationship writes**: there is no HTTP write API yet. Mutations are
  operator / control-plane actions against the authenticated database
  (threat model row 2 keeps the authorized-mutation API as future work).

## Fail-closed behavior

- No artifact / no active policy → checks and `/version` answer **503**.
- `UAE_PG_URL` configured but the database unreachable at startup → the
  entrypoint logs `startup_failed` and exits non-zero. It never silently
  falls back to an empty store.
- Missing/invalid API key → **401**; malformed JSON → **400**; oversized
  body → **413**; rate exceeded → **429**.

## Environment reference

See the deployment section of `.env.example` for every variable:
`PORT`, `UAE_API_KEYS`, `UAE_ARTIFACT_PATH`, `UAE_PUBLIC_KEYS_PATH`,
`UAE_REQUIRE_SIGNATURE`, `UAE_PG_URL`, `UAE_RUN_MIGRATIONS`,
`UAE_MAX_BODY_BYTES`, `UAE_RATE_LIMIT_PER_MINUTE`.
