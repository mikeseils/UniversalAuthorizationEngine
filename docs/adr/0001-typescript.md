# ADR-0001: Use TypeScript as the primary implementation language

- Status: Accepted
- Date: 2026-09-21
- Context: Phase 0 — repository foundation

## Context

The Universal Authorization Engine needs an implementation language for its core,
SDKs, CLI, and eventual service infrastructure. Development happens on Windows
(VS Code, PowerShell, Git) with Node.js already available (v18.14.2).

## Decision

Use **TypeScript** (strict mode, ES modules) as the primary language.

## Reasons

- Excellent developer experience with strong static typing — critical for a
  security project where malformed data must be caught at the boundary.
- The likely first adopters are JavaScript/TypeScript application developers;
  SDK adoption is trivial.
- First-class Windows support (Node.js, pnpm, Vitest, ESLint all work in PowerShell).
- Suitable for CLI tooling and eventual server infrastructure.
- Rich ecosystem for parsing, testing, and tooling.

## Consequences

- The **authorization model itself is documented as language-independent**.
  Domain semantics (default-deny, determinism, evaluation order) are specified
  in `docs/design/evaluation-model.md` in neutral terms so a future Rust/WASM
  core (see roadmap, "Embedded engine") could reimplement them with the same
  behavior and test suite.
- Strict compiler settings are mandatory (`tsconfig.json`): `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Security code must
  not rely on unsound type assumptions.
- Public API shapes are treated as **non-final** until documented as stable.

## Alternatives considered

- **Go**: strong for services and CLIs; weaker for the likely JS-first SDK story.
- **Rust**: ideal for a future high-performance compiled core; too costly for
  iterating on the authorization model now. Revisit as a compiled core target.
- **Python**: good for DX but weaker static guarantees for security-critical code.
