import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../packages/cli/src/index.js";
import { removeDir, tempDir, writeFile } from "./cli-helpers.js";

/**
 * The one suite that spawns a real process (ADR-0013).
 *
 * Everything else drives `run(argv, io)` in-process; this exists because the
 * promise in ADR-0013 is specifically that the **binary** works — shebang, bin
 * entry point, and exit-code propagation to the shell. Those are exactly the
 * things Windows gets wrong and in-process tests cannot see.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(REPO_ROOT, "packages", "cli", "dist", "main.js");

const dirs: string[] = [];

function parent(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}

beforeAll(() => {
  if (!existsSync(MAIN)) {
    // Build on demand rather than skipping: a skipped test is a silent gap, and
    // `pnpm test` on a fresh clone should still verify the binary.
    execSync("pnpm --filter @uae/cli run build", { cwd: REPO_ROOT, stdio: "pipe" });
  }
});

afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

interface BinaryResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Run the built binary through `node`, capturing status and streams. */
function binary(args: readonly string[], cwd: string = REPO_ROOT): BinaryResult {
  try {
    const out = execFileSync(process.execPath, [MAIN, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, out: failure.stdout ?? "", err: failure.stderr ?? "" };
  }
}

describe("authz binary smoke test (ADR-0013)", () => {
  it("prints usage and exits 0 for --help", () => {
    const result = binary(["--help"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("validate");
    expect(result.out).toContain("Exit codes:");
  });

  it("exits 2 for an unknown command", () => {
    const result = binary(["frobnicate"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("unknown command");
  });

  it("propagates ALLOW as exit 0 and DENY as exit 3 through the real process", () => {
    // The whole point: a shell can branch on these codes.
    const allowed = binary([
      "check",
      "user:alice",
      "document.read",
      "document:a",
      "--policy",
      join(REPO_ROOT, "examples", "acme", "policy.authz"),
      "--relationships",
      join(REPO_ROOT, "examples", "acme", "relationships.jsonl"),
    ]);
    expect(allowed.code).toBe(EXIT.ok);
    expect(allowed.out).toContain("ALLOW");

    const denied = binary([
      "check",
      "user:bob",
      "document.delete",
      "document:a",
      "--policy",
      join(REPO_ROOT, "examples", "acme", "policy.authz"),
      "--relationships",
      join(REPO_ROOT, "examples", "acme", "relationships.jsonl"),
    ]);
    expect(denied.code).toBe(EXIT.denied);
    expect(denied.out).toContain("DENY");
  });

  it("runs the full init → validate → test workflow as a real process", () => {
    const projectDir = parent();
    const created = binary(["init", "svc"], projectDir);
    expect(created.code).toBe(EXIT.ok);

    const cwd = join(projectDir, "svc");
    expect(existsSync(join(cwd, "authz.json"))).toBe(true);

    const validated = binary(["validate"], cwd);
    expect(validated.code, validated.err).toBe(EXIT.ok);

    const tested = binary(["test"], cwd);
    expect(tested.code, tested.err).toBe(EXIT.ok);
    expect(tested.out).toMatch(/assertion\(s\) passed/u);
    expect(tested.out).not.toContain("0/");
  });

  it("reports a policy error on stderr with a non-zero exit", () => {
    const projectDir = parent();
    const policy = writeFile(projectDir, "broken.authz", "definition x {\n  relation y user\n}\n");
    const result = binary(["validate", policy]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("error:");
  });
});
