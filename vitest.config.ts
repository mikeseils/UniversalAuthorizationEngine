import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Test wiring (ADR-0003).
 *
 * Workspace packages are aliased to their **source** entry points so the suite
 * runs against what is in the working tree: no build step is required before
 * `pnpm test`, and a stale `dist/` can never make a test pass that would fail on
 * source. The engine suites already import by relative path; these aliases are
 * what lets the CLI and SDK suites work the same way.
 */
const source = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@uae/core": source("core"),
      "@uae/policy": source("policy"),
      "@uae/evaluator": source("evaluator"),
      "@uae/cli": source("cli"),
      "@uae/sdk": source("sdk"),
      "@uae/persistence": source("persistence"),
    },
  },
  test: {
    // Suites live flat in `tests/` (docs/development/testing.md), so the
    // include list is explicit: no source-adjacent tests, no stray discovery.
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
