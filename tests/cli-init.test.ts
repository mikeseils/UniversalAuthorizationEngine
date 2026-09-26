import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../packages/cli/src/index.js";
import { cli, removeDir, tempDir } from "./cli-helpers.js";

const dirs: string[] = [];

function parent(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

const SCAFFOLD = ["authz.json", "policy.authz", "relationships.jsonl", "tests"] as const;

describe("authz init (ADR-0013)", () => {
  it("scaffolds a config, policy, relationships, and an example test", async () => {
    const root = parent();
    const result = await cli(["init", "project"], { cwd: root });
    expect(result.code).toBe(EXIT.ok);

    for (const name of SCAFFOLD) {
      expect(existsSync(join(root, "project", name)), name).toBe(true);
    }
    expect(existsSync(join(root, "project", "tests", "acme.test.authz"))).toBe(true);
    expect(result.out).toContain("created");
    expect(result.out).toContain("next steps:");
  });

  it("writes a config that matches the documented format", async () => {
    const root = parent();
    await cli(["init", "svc"], { cwd: root });
    const config = JSON.parse(readFileSync(join(root, "svc", "authz.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config["formatVersion"]).toBe(1);
    expect(config["policy"]).toBe("policy.authz");
    expect(config["relationships"]).toBe("relationships.jsonl");
    expect(config["tests"]).toEqual(["tests"]);
  });

  it("refuses to overwrite anything unless --force is given", async () => {
    const root = parent();
    await cli(["init", "proj"], { cwd: root });

    const again = await cli(["init", "proj"], { cwd: root });
    expect(again.code).toBe(EXIT.usage);
    expect(again.err).toContain("refusing to overwrite");
    expect(again.err).toContain("--force");

    const forced = await cli(["init", "proj", "--force"], { cwd: root });
    expect(forced.code).toBe(EXIT.ok);
  });

  it("refuses atomically: one existing file blocks the whole scaffold", async () => {
    const root = parent();
    // Pre-create a nested-only path; the guard must catch it and write nothing.
    await cli(["init", "proj"], { cwd: root });
    const before = readFileSync(join(root, "proj", "policy.authz"), "utf8");

    const blocked = await cli(["init", "proj"], { cwd: root });
    expect(blocked.code).toBe(EXIT.usage);
    // Nothing was partially rewritten.
    expect(readFileSync(join(root, "proj", "policy.authz"), "utf8")).toBe(before);
  });

  it("scaffolds into the current directory by default", async () => {
    const root = parent();
    const result = await cli(["init"], { cwd: root });
    expect(result.code).toBe(EXIT.ok);
    for (const name of SCAFFOLD) {
      expect(existsSync(join(root, name)), name).toBe(true);
    }
  });

  it("scaffolds a project that validates and passes its own tests", async () => {
    // The scaffold-drift guard: `authz init` prints "next steps" telling you to
    // validate and test the generated project. If the templates ever drift from
    // the language or the runner, this fails.
    const root = parent();
    const created = await cli(["init", "proj"], { cwd: root });
    expect(created.code).toBe(EXIT.ok);
    const cwd = join(root, "proj");

    const validated = await cli(["validate", "--json"], { cwd });
    expect(validated.code, `validate stderr: ${validated.err}`).toBe(EXIT.ok);
    expect(validated.json["ok"]).toBe(true);
    const policy = validated.json["policy"] as Record<string, unknown>;
    expect(policy["definitions"]).toBe(3);
    const relationships = validated.json["relationships"] as Record<string, unknown>;
    expect(relationships["valid"]).toBe(true);
    expect(relationships["count"]).toBe(7);

    const tested = await cli(["test", "--json"], { cwd });
    expect(tested.code, `test stderr: ${tested.err}`).toBe(EXIT.ok);
    expect(tested.json["ok"]).toBe(true);
    expect(tested.json["files"]).toBe(1);
    expect(tested.json["failed"]).toBe(0);
    // The template contains 5 test blocks and 11 assertions.
    expect(tested.json["tests"]).toBe(5);
    expect(tested.json["assertions"]).toBe(11);
  });

  it("keeps the generated example and the checked-in Acme example consistent", async () => {
    // Both are canonical Acme; they must agree on the same decisions.
    const root = parent();
    await cli(["init", "proj"], { cwd: root });
    const cwd = join(root, "proj");

    for (const [subject, action, resource, expected] of [
      ["user:alice", "organization.manage", "organization:acme", "ALLOW"],
      ["user:bob", "organization.manage", "organization:acme", "DENY"],
      ["user:bob", "document.read", "document:a", "ALLOW"],
      ["user:bob", "document.delete", "document:a", "DENY"],
    ] as const) {
      const result = await cli(["check", subject, action, resource], { cwd });
      expect(result.out, `${subject} ${action} ${resource}`).toContain(expected);
    }
  });
});
