# ADR-0003: Use Vitest as the test framework

- Status: Accepted
- Date: 2026-09-21

## Context

Authorization bugs are security bugs, so testing is a first-class concern
(`docs/development/testing.md`). The framework must work with TypeScript ESM,
strict settings, Windows, and Node 18, and run fast locally.

## Decision

Use **Vitest** (v2.x, compatible with Node 18) as the test runner.

## Comparison

| Criterion             | Vitest                     | Jest                          |
| --------------------- | -------------------------- | ----------------------------- |
| Native TS/ESM support | Yes, no transform config   | Requires ts-jest/babel config |
| Windows/PowerShell    | Reliable                   | Reliable                      |
| Local speed           | Very fast (esbuild, watch) | Slower startup                |
| Watch & DX            | Excellent                  | Good                          |
| Ecosystem match       | Modern TS projects         | Legacy default                |

## Consequences

- Tests live next to source (`*.test.ts`) and under `tests/` for integration
  and security suites.
- Property-based tests (Phase 7+) will use a Vitest-compatible property library;
  not needed yet.
- Coverage tooling comes from Vitest's built-in provider when first needed.
