import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { EXIT, assertionHolds } from "../packages/cli/src/index.js";
import {
  ACME_DIR,
  ACME_POLICY,
  ACME_RELATIONSHIPS,
  ACME_TESTS_DIR,
  cli,
  removeDir,
  tempDir,
  writeFile,
  type CliResult,
} from "./cli-helpers.js";

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = tempDir();
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFile(dir, name, content);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

const POLICY = [
  "definition organization {",
  "  relation admin: user",
  "  relation member: user",
  "  permission manage = admin",
  "  permission read = admin or member",
  "}",
  "definition project {",
  "  relation organization: organization via owns",
  "  relation owner: user",
  "  relation viewer: user",
  "  permission read = viewer or owner or organization.read",
  "  permission delete = owner or organization.manage",
  "}",
  "",
].join("\n");

const RELATIONSHIPS = [
  '{"formatVersion":1}',
  '{"subject":"user:alice","relation":"admin","resource":"organization:acme"}',
  '{"subject":"organization:acme","relation":"owns","resource":"project:alpha"}',
  '{"subject":"user:bob","relation":"viewer","resource":"project:alpha"}',
  "",
].join("\n");

function suite(name: string, body: string): string {
  return `test "${name}" {\n${body}}\n`;
}

/** Run `authz test` against a project built by {@link project}. */
function runTests(dir: string, extra: readonly string[] = []): Promise<CliResult> {
  return cli([
    "test",
    "--policy",
    join(dir, "policy.authz"),
    "--relationships",
    join(dir, "relationships.jsonl"),
    join(dir, "tests"),
    ...extra,
  ]);
}

describe("authz test (ADR-0013/0014)", () => {
  it("passes a valid suite and reports counts", async () => {
    const dir = project({
      "policy.authz": POLICY,
      "relationships.jsonl": RELATIONSHIPS,
      "tests/basic.test.authz": suite(
        "alice administers",
        "  check(user:alice, organization.read, organization:acme) == allow\n  check(user:alice, organization.manage, organization:acme) == allow\n",
      ),
    });
    const result = await runTests(dir);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("2/2 assertion(s) passed");
    expect(result.err).toBe("");
  });

  it("fails with exit 1 and shows the explanation for a wrong assertion", async () => {
    const dir = project({
      "policy.authz": POLICY,
      "relationships.jsonl": RELATIONSHIPS,
      "tests/bad.test.authz": suite(
        "bob may delete",
        "  check(user:bob, project.delete, project:alpha) == allow\n",
      ),
    });
    const result = await runTests(dir);
    expect(result.code).toBe(EXIT.validation);
    expect(result.out).toContain("FAIL");
    expect(result.out).toContain("expected: allow");
    expect(result.out).toContain("0/1 assertion(s) passed");
    // The failing assertion explains itself, so the terminal answers "why".
    expect(result.out).toContain("explanation:");
  });

  it("emits the documented JSON result document", async () => {
    const dir = project({
      "policy.authz": POLICY,
      "relationships.jsonl": RELATIONSHIPS,
      "tests/bad.test.authz": suite(
        "bob may delete",
        "  check(user:bob, project.delete, project:alpha) == allow\n",
      ),
    });
    const result = await runTests(dir, ["--json"]);
    expect(result.code).toBe(EXIT.validation);
    expect(result.json["ok"]).toBe(false);
    expect(result.json["files"]).toBe(1);
    expect(result.json["tests"]).toBe(1);
    expect(result.json["assertions"]).toBe(1);
    expect(result.json["passed"]).toBe(0);
    expect(result.json["failed"]).toBe(1);
    const failures = result.json["failures"] as Record<string, unknown>[];
    expect(failures).toHaveLength(1);
    const first = failures[0] ?? {};
    expect(first["test"]).toBe("bob may delete");
    expect(first["expected"]).toBe("allow");
    expect(first["line"]).toBeGreaterThan(0);
    expect((first["actual"] as Record<string, unknown> | undefined)?.["reason"]).toBe(
      "policy_deny",
    );
    expect(result.json["errors"]).toEqual([]);
  });

  it("never lets a `deny` assertion pass on an `error` outcome (ADR-0014)", () => {
    // The invariant, stated directly: a broken policy must not look like a
    // passing negative test. `deny` requires the normal, explained policy deny.
    expect(assertionHolds({ allowed: false, reason: "policy_deny" }, "deny")).toBe(true);
    expect(assertionHolds({ allowed: false, reason: "error" }, "deny")).toBe(false);
    expect(assertionHolds({ allowed: false, reason: "error" }, "error")).toBe(true);
    expect(assertionHolds({ allowed: false, reason: "policy_deny" }, "error")).toBe(false);
    expect(assertionHolds({ allowed: true, reason: "policy_allow" }, "allow")).toBe(true);
    expect(assertionHolds({ allowed: false, reason: "policy_deny" }, "allow")).toBe(false);
  });

  it("reports a malformed test file without hiding the other files", async () => {
    const dir = project({
      "policy.authz": POLICY,
      "relationships.jsonl": RELATIONSHIPS,
      "tests/a-broken.test.authz": 'test "broken" {\n  check(user:a, x.read, x:1) == maybe\n}\n',
      "tests/b-good.test.authz": suite(
        "alice administers",
        "  check(user:alice, organization.read, organization:acme) == allow\n",
      ),
    });
    const result = await runTests(dir, ["--json"]);
    expect(result.code).toBe(EXIT.validation);
    expect((result.json["errors"] as string[]).length).toBe(1);
    expect(result.json["files"]).toBe(1);
    expect(result.json["passed"]).toBe(1);
  });

  it("discovers test files in a deterministic, sorted order", async () => {
    const dir = project({
      "policy.authz": POLICY,
      "relationships.jsonl": RELATIONSHIPS,
      "tests/b.test.authz": suite(
        "b",
        "  check(user:alice, organization.read, organization:acme) == allow\n",
      ),
      "tests/a.test.authz": suite(
        "a",
        "  check(user:alice, organization.read, organization:acme) == allow\n",
      ),
      "tests/nested/c.test.authz": suite(
        "c",
        "  check(user:alice, organization.read, organization:acme) == allow\n",
      ),
    });
    const result = await runTests(dir);
    expect(result.code).toBe(EXIT.ok);
    const a = result.out.indexOf("a.test.authz");
    const b = result.out.indexOf("b.test.authz");
    const c = result.out.indexOf("c.test.authz");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("isolates each test block's `given` tuples", async () => {
    const dir = project({
      "policy.authz": POLICY,
      "relationships.jsonl": RELATIONSHIPS,
      "tests/isolation.test.authz": [
        'test "grants carol ownership" {',
        "  given {",
        "    user:carol owner project:alpha",
        "  }",
        "  check(user:carol, project.read, project:alpha) == allow",
        "}",
        "",
        'test "does not inherit the earlier given" {',
        "  check(user:carol, project.read, project:alpha) == deny",
        "}",
        "",
      ].join("\n"),
    });
    const result = await runTests(dir);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("2/2 assertion(s) passed");
  });

  it("discovers policy, relationships, and tests from authz.json", async () => {
    const dir = project({
      "authz.json": [
        "{",
        '  "formatVersion": 1,',
        '  "policy": "policy.authz",',
        '  "relationships": "relationships.jsonl",',
        '  "tests": ["tests"]',
        "}",
        "",
      ].join("\n"),
      "policy.authz": POLICY,
      "relationships.jsonl": RELATIONSHIPS,
      "tests/ok.test.authz": suite(
        "alice administers",
        "  check(user:alice, organization.manage, organization:acme) == allow\n",
      ),
    });
    // No flags, no positionals: everything comes from the discovered config.
    const result = await cli(["test"], { cwd: dir });
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("1/1 assertion(s) passed");
  });

  it("refuses to guess when no tests are configured", async () => {
    const dir = project({ "policy.authz": POLICY });
    const result = await cli(["test", "--policy", join(dir, "policy.authz")], { cwd: dir });
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("no tests configured");
  });

  it("reports a missing test path as a usage error", async () => {
    const dir = project({ "policy.authz": POLICY });
    const result = await cli([
      "test",
      "--policy",
      join(dir, "policy.authz"),
      join(dir, "does-not-exist"),
    ]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("test path not found");
  });

  it("reports an empty directory as a usage error, not a pass", async () => {
    // An empty suite must not silently "succeed" — that is how a broken CI job
    // looks green.
    const dir = project({ "policy.authz": POLICY, "tests/.keep": "" });
    const result = await cli(["test", "--policy", join(dir, "policy.authz"), join(dir, "tests")]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/no \.test\.authz files found/u);
  });

  it("runs the canonical example project on disk (examples/acme)", async () => {
    // Phase 4 closeout: the example is runnable, and this guards it against
    // drifting away from the engine's own behaviour.
    const validate = await cli([
      "validate",
      ACME_POLICY,
      "--relationships",
      ACME_RELATIONSHIPS,
      "--json",
    ]);
    expect(validate.code).toBe(EXIT.ok);
    expect(validate.json["ok"]).toBe(true);

    const tested = await cli(["test"], { cwd: ACME_DIR });
    expect(tested.code).toBe(EXIT.ok);
    expect(tested.err).toBe("");
    expect(tested.out).toMatch(/assertion\(s\) passed/u);
    expect(tested.out).not.toContain("0/");
  });

  it("exposes the example test directory", () => {
    expect(ACME_TESTS_DIR).toContain("acme");
  });
});
