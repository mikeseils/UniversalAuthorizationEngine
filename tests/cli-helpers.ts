/**
 * Shared wiring for CLI tests (ADR-0013).
 *
 * Every command is driven through `run(argv, io)` with captured io, so the real
 * code paths execute **without spawning a process**. Filesystem state lives in
 * `node:os` temporary directories: no test depends on the developer's working
 * directory and nothing is left behind.
 *
 * (`tests/cli-smoke.test.ts` is the one deliberate exception — it spawns the
 * built binary, because that is the only way to prove the `bin`/shebang wiring.)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCapturingIo, run, type ExitCode } from "../packages/cli/src/index.js";

/** The canonical example project on disk (examples/acme). */
export const ACME_DIR = fileURLToPath(new URL("../examples/acme/", import.meta.url));
export const ACME_POLICY = join(ACME_DIR, "policy.authz");
export const ACME_RELATIONSHIPS = join(ACME_DIR, "relationships.jsonl");
export const ACME_TESTS_DIR = join(ACME_DIR, "tests");

export interface CliResult {
  readonly code: ExitCode;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** stdout joined, for substring assertions. */
  readonly out: string;
  /** stderr joined, for diagnostic assertions. */
  readonly err: string;
  /** stdout parsed as JSON when it is JSON, otherwise `{}`. */
  readonly json: Record<string, unknown>;
}

export interface CliRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTty?: boolean;
}

/** Run the CLI in-process and capture everything it wrote. */
export async function cli(
  argv: readonly string[],
  options: CliRunOptions = {},
): Promise<CliResult> {
  const io = createCapturingIo(options);
  const code = await run(argv, io);
  const out = io.output.join("\n");
  const err = io.errors.join("\n");
  return { code, stdout: io.output, stderr: io.errors, out, err, json: parseJson(out) };
}

function parseJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Create an isolated temp directory for one test case. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "uae-cli-"));
}

/** Remove a directory created by {@link tempDir}. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Write a file (creating parents) and return its absolute path. */
export function writeFile(dir: string, relative: string, content: string): string {
  const full = join(dir, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

export function readAcmePolicy(): string {
  return readFileSync(ACME_POLICY, "utf8");
}

export function readAcmeRelationships(): string {
  return readFileSync(ACME_RELATIONSHIPS, "utf8");
}

/**
 * A minimal, valid policy + relationship pair in a temp directory, for tests
 * that need a working project but not the full Acme example.
 */
export function minimalProject(dir: string): { policy: string; relationships: string } {
  const policy = writeFile(
    dir,
    "policy.authz",
    [
      "definition organization {",
      "  relation admin: user",
      "  permission manage = admin",
      "}",
      "",
    ].join("\n"),
  );
  const relationships = writeFile(
    dir,
    "relationships.jsonl",
    [
      '{"formatVersion":1}',
      '{"subject":"user:alice","relation":"admin","resource":"organization:acme"}',
      "",
    ].join("\n"),
  );
  return { policy, relationships };
}
