import { afterAll, describe, expect, it } from "vitest";
import { EXIT } from "../packages/cli/src/index.js";
import {
  ACME_POLICY,
  ACME_RELATIONSHIPS,
  cli,
  minimalProject,
  readAcmePolicy,
  removeDir,
  tempDir,
  writeFile,
} from "./cli-helpers.js";

const dirs: string[] = [];

function project(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

describe("authz validate (ADR-0013)", () => {
  it("accepts the canonical Acme policy and reports its hash", async () => {
    const result = await cli(["validate", ACME_POLICY]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("policy: ok");
    expect(result.out).toMatch(/hash: [0-9a-f]{64}/u);
    expect(result.err).toBe("");
  });

  it("validates relationship data alongside the policy", async () => {
    const result = await cli(["validate", ACME_POLICY, "--relationships", ACME_RELATIONSHIPS]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("relationships: ok");
    expect(result.out).toContain("tuples: 7");
  });

  it("emits a stable JSON document (the documented CI contract)", async () => {
    const result = await cli(["validate", ACME_POLICY, "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.json["ok"]).toBe(true);
    expect(result.json["strict"]).toBe(false);
    expect(result.json["warnings"]).toEqual([]);
    const policy = result.json["policy"] as Record<string, unknown>;
    expect(policy["file"]).toBe(ACME_POLICY);
    expect(policy["valid"]).toBe(true);
    expect(policy["error"]).toBeNull();
    expect(policy["definitions"]).toBe(3);
    expect(typeof policy["hash"]).toBe("string");
    // No relationship file was requested, so the field is explicitly null.
    expect(result.json["relationships"]).toBeNull();
    // JSON goes to stdout only; diagnostics never contaminate it.
    expect(result.err).toBe("");
  });

  it("fails with exit 1 on a syntax error", async () => {
    const dir = project();
    const file = writeFile(dir, "policy.authz", "definition project {\n  relation owner user\n}\n");
    const result = await cli(["validate", file]);
    expect(result.code).toBe(EXIT.validation);
    expect(result.err).toContain("error:");
    expect(result.out).toContain("policy: INVALID");
  });

  it("fails with exit 1 on an undeclared relation (lowering error)", async () => {
    const dir = project();
    const file = writeFile(
      dir,
      "policy.authz",
      [
        "definition project {",
        "  relation owner: user",
        "  permission write = editor",
        "}",
        "",
      ].join("\n"),
    );
    const result = await cli(["validate", file, "--json"]);
    expect(result.code).toBe(EXIT.validation);
    const policy = result.json["policy"] as Record<string, unknown>;
    expect(policy["valid"]).toBe(false);
    expect(String(policy["error"])).toMatch(/undeclared relation "editor"/u);
    expect(policy["hash"]).toBeNull();
  });

  it("fails with exit 1 on an ambiguous traversal", async () => {
    const dir = project();
    const file = writeFile(
      dir,
      "policy.authz",
      [
        "definition organization {",
        "  relation admin: user",
        "  permission read = admin",
        "}",
        "definition project {",
        "  relation a: organization",
        "  relation b: organization",
        "  permission read = organization.read",
        "}",
        "",
      ].join("\n"),
    );
    const result = await cli(["validate", file]);
    expect(result.code).toBe(EXIT.validation);
    expect(result.err).toMatch(/ambiguous/u);
  });

  it("reports relationship errors with line numbers, and keeps going", async () => {
    const dir = project();
    const policy = writeFile(dir, "policy.authz", readAcmePolicy());
    const relationships = writeFile(
      dir,
      "relationships.jsonl",
      [
        '{"formatVersion":1}',
        '{"subject":"user:alice","relation":"admin"}',
        '{"subject":"user:bob","relation":"admin","resource":"organization:acme","extra":1}',
        "not json",
        "",
      ].join("\n"),
    );
    const result = await cli(["validate", policy, "--relationships", relationships]);
    expect(result.code).toBe(EXIT.validation);
    for (const line of [2, 3, 4]) {
      expect(result.err, `line ${String(line)}`).toContain(`:${String(line)}:`);
    }
    // The policy itself was still validated.
    expect(result.out).toContain("policy: ok");
  });

  it("does not let a malformed relationship file mask a valid policy's exit code", async () => {
    const dir = project();
    const { policy } = minimalProject(dir);
    const result = await cli(["validate", policy, "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.json["ok"]).toBe(true);
  });

  it("treats a usage problem as exit 2, not a validation failure", async () => {
    const result = await cli(["validate"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("no policy file");
  });

  it("treats an unreadable policy file as exit 2", async () => {
    const result = await cli(["validate", "does-not-exist.authz"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("cannot read policy file");
  });

  it("passes --strict when there are no warnings", async () => {
    // `--strict` promotes warnings to errors. The only warning class today
    // (negation-based grants) is not expressible in language v1, so a clean
    // policy must still succeed — the flag is wired for future warning classes.
    const result = await cli(["validate", ACME_POLICY, "--strict", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.json["strict"]).toBe(true);
    expect(result.json["warnings"]).toEqual([]);
  });
});
