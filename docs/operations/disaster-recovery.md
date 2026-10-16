# Disaster Recovery

Status: **Operational runbook.** Fail-closed is invariant (ADR-0006): when the
data plane cannot answer correctly, callers receive a typed
`AUTHZ_UNAVAILABLE` / HTTP 503 — never a fabricated ALLOW or DENY. Recovery
procedures below therefore aim to _restore answerability_, not to paper over
failures.

## Recovery objectives

| Objective | Guidance                                                         |
| --------- | ---------------------------------------------------------------- |
| RPO       | Policy source: zero (git). Relationships: last Postgres backup.  |
| RTO       | Minutes: the data plane is a stateless process behind one image. |
| Priority  | Restore answerability (healthz green, artifact loaded) first.    |

## What state exists

| State                     | Location                              | Backup strategy                                    |
| ------------------------- | ------------------------------------- | -------------------------------------------------- |
| Policy source             | Git repository                        | Any remote (`origin`); history is the backup       |
| Compiled policy artifacts | Built from source (control plane/CLI) | Regenerate; retain last-good artifact per release  |
| Relationships (optional)  | PostgreSQL                            | `pg_dump` on a schedule; see below                 |
| API keys                  | Environment (`UAE_API_KEYS`)          | Secret store — rotate, do not restore              |
| Signing keys              | Environment (`UAE_PUBLIC_KEYS_PATH`)  | Secret store; public keys are safe to redistribute |
| Metrics/logs              | Scraped from `/metrics`, stdout JSON  | Observability stack's concern, not the engine's    |

The data plane itself holds **no durable state**: it serves a compiled artifact
loaded at startup (ADR-0007). Anything it "knows" can be rebuilt from the
repository plus the artifact.

## Failure scenarios

### 1. Data plane process or container down

Symptom: clients get connection errors or `transport_error`; orchestrator
shows the container restarting.

```powershell
docker compose ps
docker compose logs data-plane --tail 100
docker compose up -d --force-recreate data-plane
curl http://localhost:3000/healthz
```

Fail-closed guarantees no incorrect decisions were served while down — callers
saw errors, not wrong answers.

### 2. Corrupt or missing policy artifact

Symptom: container exits at startup with `startup_failed`, or checks return
503 because the store has no active version.

1. Restore the last-good artifact JSON (retained per release) to the mounted
   volume path (default `./artifact/policy.json`).
2. If artifact signatures are enforced (`UAE_REQUIRE_SIGNATURE=true`), verify
   the artifact against a known public key before restoring.
3. Recreate: `docker compose up -d --force-recreate data-plane`.
4. Verify with a known-good check (see [Verification](#verification)).

### 3. Bad policy published (authorization results look wrong)

Policies are versioned and pinned (ADR-0019): a bad publish never mutates the
old version.

1. Identify the last-good version: `GET /version` (once implemented) or the
   artifact's `version` field.
2. Rebuild/serve the artifact for the previous version (control plane/CLI
   rollback), or re-publish the known-good policy source from git.
3. Redeploy the data plane with the rolled-back artifact.
4. Re-run the verification checklist.

### 4. Database loss (PostgreSQL, optional)

The default configuration and test suites never touch a database. Only the
relationship store (ReBAC edges) lives in Postgres.

```powershell
# restore from the most recent dump
psql $env:AUTHZ_TEST_PG_URL -f backup.dump
```

Until restoration completes, relationship reads fail typed-unavailable and the
data plane returns 503 — fail-closed, never a silent empty graph. If the data
plane does not use Postgres (artifact-only deployment), no action is needed.

### 5. Host or region loss

1. Provision a new host with Docker.
2. `git clone <repo-url>` and check out the released tag.
3. Recreate secrets in `.env` (`UAE_API_KEYS`, artifact paths).
4. `docker compose up -d --build` (or pull the released image and tag it).
5. Run the verification checklist.

### 6. Credential or signing-key compromise

- **API keys**: rotate by replacing `UAE_API_KEYS` and recreating the
  container. Old keys stop working immediately — clients must be updated.
- **Artifact signing key**: generate a new key pair, re-sign the active
  artifact with the new `keyId`, distribute the new public key via
  `UAE_PUBLIC_KEYS_PATH`, then recreate the data plane. Unsigned or
  wrongly-signed artifacts are rejected at startup when signatures are
  required (ADR-0024).

## Backup procedures

```powershell
# Postgres (only if the deployment uses it)
pg_dump --format=custom $env:AUTHZ_TEST_PG_URL > "uae-$(Get-Date -Format yyyyMMdd).dump"

# Retain the last-good compiled artifact alongside each release
Copy-Item .\artifact\policy.json ".\releases\policy-<version>.json"
```

Policy source needs no special procedure beyond pushing to `origin` — every
commit is a restorable point.

## Verification

After any recovery, confirm answerability:

```powershell
# 1. health (no auth required)
curl http://localhost:3000/healthz

# 2. metrics endpoint responds (no auth required)
curl http://localhost:3000/metrics

# 3. an authenticated check succeeds or denies *by policy* — not 503
curl -X POST http://localhost:3000/check `
  -H "Authorization: Bearer $env:UAE_API_KEYS" `
  -H "Content-Type: application/json" `
  -d '{"subject":"user:alice","action":"project.read","resource":"project:alpha"}'
```

A `503` here means the store/artifact is still unavailable — the system is
still fail-closed and **not yet recovered**; check
`docker compose logs data-plane` for `startup_failed` or store errors.

## Ongoing health signals

- `uae_checks_unavailable` on `/metrics` climbing while healthy traffic flows
  is the earliest signal of store/artifact trouble.
- Container restarts with `startup_failed` indicate artifact/config drift, not
  engine failure.
- Structured JSON logs on stdout (`level`, `event` fields) feed any log
  pipeline without parsing changes.
