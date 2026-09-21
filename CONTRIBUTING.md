# Contributing

Thanks for contributing to the Universal Authorization Engine. Authorization
is security infrastructure, so the rules below are stricter than average.

## Ground rules

1. **Correctness over speed.** No demo-first shortcuts on deterministic
   behavior, security, testability, explainability, or explicit failure modes.
2. **Default deny is non-negotiable** (ADR-0006). Any evaluation failure must
   never become an authorization success. Exceptions require an ADR + tests.
3. **Documentation and ADRs precede substantial implementation.** Changing a
   security-relevant design requires an ADR first.
4. **Keep the core independent**: no framework/DB/cloud/IdP dependencies in
   `packages/core`; adapters live around the core.

## Workflow

- Branch from `main`: `feature/...` for substantial work; `main` must always
  be buildable and green.
- Descriptive commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Before opening a PR, in PowerShell:

  ```powershell
  pnpm install
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test
  pnpm build
  ```

- PRs run the same pipeline in CI; they must pass to merge.

## Testing expectations

- Every documented behavior has a test; security-relevant changes include
  adversarial tests (see `docs/development/testing.md`).
- Malformed input tests: boundaries reject, never coerce.
- No performance claims without benchmarks.

## Documentation

- Distinguish **Implemented / Planned / Experimental / Deferred** honestly.
- Never claim a feature is implemented when it is planned.
- Public API shapes are DRAFT until an ADR stabilizes them
  (`docs/architecture/api-boundaries.md`).

## Committing

Never commit `.env*`, credentials, API keys, tokens, or private certificates.
Example values must be clearly marked and non-functional.
