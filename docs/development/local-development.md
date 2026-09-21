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

# fix formatting
pnpm format

# clean build artifacts
Get-ChildItem -Recurse -Directory -Exclude node_modules -Include dist | Remove-Item -Recurse -Force
```

## VS Code

Recommended extensions are in `.vscode/extensions.json`; shared settings
(format-on-save via Prettier, ESLint autofix) are in `.vscode/settings.json`.

## CI parity

GitHub Actions runs install → typecheck → lint → test → build on PRs and
pushes to `main` (see `.github/workflows/ci.yml`) with pnpm store caching.
If it passes locally with the commands above, CI should pass.
