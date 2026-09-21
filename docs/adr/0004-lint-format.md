# ADR-0004: ESLint (flat config) + Prettier for linting and formatting

- Status: Accepted
- Date: 2026-09-21

## Context

The project needs consistent formatting and strict static analysis.
TypeScript-aware linting (including type-checked rules) matters more than usual
here because authorization code must not rely on unsound or unsafe patterns.

## Decision

Use **ESLint 9 flat config** with **typescript-eslint** (`strictTypeChecked`
ruleset) for linting, and **Prettier** for formatting, kept as separate tools.

## Reasons

- Type-checked lint rules catch real defect classes (unsafe assertions,
  floating promises, non-null assertions) that matter in security code.
- Flat config is the current ESLint standard and is fully Node/PowerShell
  friendly.
- A consolidated all-in-one tool (e.g. Biome) was considered but rejected at
  this stage: typescript-eslint's type-checked rules are the strongest
  TypeScript-specific analysis currently available. Revisit later if tool
  overhead becomes a problem.

## Consequences

- `pnpm lint` runs ESLint; `pnpm format` / `pnpm format:check` run Prettier.
- `dist/`, `coverage/`, and lockfiles are excluded from both.
