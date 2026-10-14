# Local Development

Windows-first (PowerShell), but everything works on any platform with Node.js.

## Prerequisites

- **Node.js ≥ 18.14** (`node --version`)
- **pnpm** (already the project's `packageManager`; install via
  `corepack enable` or `npm i -g pnpm`)
- Git. Docker is **not** required for basic local development.

## Setup (PowerShell)

```powershell
git clone <repo-url>
cd UniversalAuthorizationEngine
pnpm install
pnpm typecheck   # strict TypeScript across the workspace
pnpm lint        # ESLint (type-checked)
pnpm format:check
pnpm test        # Vitest
pnpm build       # build all packages
```

## Common tasks

```powershell
# run tests in watch mode
pnpm test:watch

# run tests for one package
pnpm --filter @uae/core test

# measure evaluator access patterns (ADR-0017) — builds first
pnpm bench

# fix formatting
pnpm format

# clean build artifacts
Get-ChildItem -Recurse -Directory -Exclude node_modules -Include dist | Remove-Item -Recurse -Force
```

## PostgreSQL (optional)

**Docker is not required**, and the default workflow never touches a database.
The in-memory stores are the reference implementation, and the persistence
package's SQL construction, error classification, and fail-closed behaviour are
unit-tested through a narrow `PgQueryable` interface (`tests/persistence-sql.test.ts`).
`pnpm test` is green on a fresh clone with no database running.

To additionally run the Postgres-backed suites — which execute the **same**
store conformance contract (ADR-0018) against the real driver, plus durability
and migration tests — set a connection string:

```powershell
# any reachable Postgres works; a throwaway local one is fine
$env:AUTHZ_TEST_PG_URL = "postgres://user:password@localhost:5432/uae_test"
pnpm test
```

Without that variable the Postgres suites **skip with an explicit message**
rather than failing, so a missing database can never be mistaken for a passing
persistence layer. Migrations are applied automatically by the suite
(`runMigrations`); they are tracked in `uae_schema_migrations`, so re-running
only applies files the database has not seen.

To make a missing database a **failure** instead of a skip — the same thing CI
does — set:

```powershell
$env:AUTHZ_REQUIRE_PG_TESTS = "1"
```

A local database for development:

```powershell
docker run --name uae-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=uae_test -p 5432:5432 -d postgres:16
$env:AUTHZ_TEST_PG_URL = "postgres://postgres:postgres@localhost:5432/uae_test"
```

The CLI can then evaluate against that database instead of memory:

```powershell
$env:AUTHZ_DATABASE_URL = $env:AUTHZ_TEST_PG_URL
authz check user:alice document.read document:a --store postgres
# or set AUTHZ_STORE=postgres and omit the flag
```

`--store` is opt-in and never inferred: an unknown value is a usage error rather
than a silent fall back to memory, because falling back would answer from an
empty store and report that as a confident DENY. `authz test` always runs
in-memory — each test block gets its own relationship store (ADR-0014), so a
persistent backend would be bypassed anyway.

The benchmark measures both backends when a connection string is present:

```powershell
$env:AUTHZ_TEST_PG_URL = "postgres://postgres:postgres@localhost:5432/uae_test"
pnpm bench   # in-memory AND Postgres, same evaluator and same data
```

Never commit a real connection string. `.env` and `.env.*` are gitignored; if
you need an example, `.env.example` documents placeholder values only.

## VS Code

Recommended extensions are in `.vscode/extensions.json`; shared settings
(format-on-save via Prettier, ESLint autofix) are in `.vscode/settings.json`.

## CI parity

GitHub Actions runs install → typecheck → lint → test → build on PRs and
pushes to `main` (see `.github/workflows/ci.yml`) with pnpm store caching.
If it passes locally with the commands above, CI should pass.

CI additionally provisions a **PostgreSQL service container** and sets
`AUTHZ_REQUIRE_PG_TESTS=1`, so the Postgres suites run rather than skip. That
guard is the point: without it, a misconfigured or slow-starting service
container would report green while testing nothing, and the persistence layer
would silently stop being covered exactly when it changes.
