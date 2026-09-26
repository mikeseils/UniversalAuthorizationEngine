import { afterAll, describe, expect, it } from "vitest";
import { EXIT } from "../packages/cli/src/index.js";
import {
  ACME_POLICY,
  ACME_RELATIONSHIPS,
  cli,
  removeDir,
  tempDir,
  writeFile,
} from "./cli-helpers.js";

const INVOICE_POLICY = [
  "definition invoice {",
  "  context mfa: boolean",
  "  relation approver: user",
  "  permission approve = approver and context.mfa == true",
  "}",
  "",
].join("\n");

const dirs: string[] = [];

function invoiceProject(): { policy: string; relationships: string } {
  const dir = tempDir();
  dirs.push(dir);
  const policy = writeFile(dir, "policy.authz", INVOICE_POLICY);
  const relationships = writeFile(
    dir,
    "relationships.jsonl",
    [
      '{"formatVersion":1}',
      '{"subject":"user:alice","relation":"approver","resource":"invoice:1"}',
      "",
    ].join("\n"),
  );
  return { policy, relationships };
}

afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

const acme = (argv: readonly string[]) =>
  cli(["check", ...argv, "--policy", ACME_POLICY, "--relationships", ACME_RELATIONSHIPS]);

describe("authz check (ADR-0013)", () => {
  it("exits 0 and reports ALLOW", async () => {
    const result = await acme(["user:alice", "document.read", "document:a"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("ALLOW");
  });

  it("exits 3 (deny) for a legitimate DENY — distinct from a failure", async () => {
    const result = await acme(["user:bob", "document.delete", "document:a"]);
    expect(result.code).toBe(EXIT.denied);
    expect(result.out).toContain("DENY");
    // A DENY is a successful evaluation, so nothing is written to stderr.
    expect(result.err).toBe("");
  });

  it("exits 0 for a DENY with --no-fail-on-deny", async () => {
    const result = await acme(["user:bob", "document.delete", "document:a", "--no-fail-on-deny"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("DENY");
  });

  it("emits the documented JSON decision document", async () => {
    const result = await acme(["user:alice", "document.read", "document:a", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.json["ok"]).toBe(true);
    const decision = result.json["decision"] as Record<string, unknown>;
    expect(decision["allowed"]).toBe(true);
    expect(decision["reason"]).toBe("policy_allow");
    expect(decision["policyVersion"]).toBe("1");
    // Explanation is opt-in for machine consumers: no leakage by default.
    expect(decision["explanation"]).toBeNull();
  });

  it("keeps exit 3 under --json, so scripts can branch on the code", async () => {
    const result = await acme(["user:bob", "document.delete", "document:a", "--json"]);
    expect(result.code).toBe(EXIT.denied);
    expect(result.json["ok"]).toBe(false);
    const decision = result.json["decision"] as Record<string, unknown>;
    expect(decision["allowed"]).toBe(false);
    expect(decision["reason"]).toBe("policy_deny");
  });

  it("shows a standard explanation by default in human output", async () => {
    const result = await acme(["user:bob", "document.read", "document:a"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("explanation:");
    expect(result.out).toContain("user:bob --viewer--> project:alpha");
    expect(result.out).toContain("project:alpha --contains--> document:a");
  });

  it("honors --explain debug and --explain none", async () => {
    const debug = await acme(["user:bob", "document.read", "document:a", "--explain", "debug"]);
    expect(debug.out).toContain("explanation:");

    const none = await acme(["user:bob", "document.read", "document:a", "--explain", "none"]);
    expect(none.out).not.toContain("explanation:");
  });

  it("includes the explanation in JSON only when asked", async () => {
    const result = await acme([
      "user:bob",
      "document.read",
      "document:a",
      "--json",
      "--explain",
      "standard",
    ]);
    const decision = result.json["decision"] as Record<string, unknown>;
    expect(decision["explanation"]).not.toBeNull();
  });

  it("rejects an unknown --explain level as a usage error", async () => {
    const result = await acme(["user:alice", "document.read", "document:a", "--explain", "loud"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/--explain must be one of/u);
  });

  it("applies context and denies when a condition is unsatisfied", async () => {
    const { policy, relationships } = invoiceProject();
    const base = [
      "check",
      "user:alice",
      "invoice.approve",
      "invoice:1",
      "--policy",
      policy,
      "--relationships",
      relationships,
    ];
    const allowed = await cli([...base, "--context", '{"mfa":true}']);
    expect(allowed.code).toBe(EXIT.ok);
    expect(allowed.out).toContain("ALLOW");

    const denied = await cli([...base, "--context", '{"mfa":false}']);
    expect(denied.code).toBe(EXIT.denied);

    // Missing context key: the condition is unsatisfied, never assumed true.
    const missing = await cli(base);
    expect(missing.code).toBe(EXIT.denied);
  });

  it("rejects malformed --context rather than ignoring it", async () => {
    for (const bad of ["not json", "[1,2]", "null", '{"mfa":{"nested":true}}', '{"mfa":null}']) {
      const result = await acme(["user:alice", "document.read", "document:a", "--context", bad]);
      expect(result.code, bad).toBe(EXIT.usage);
      expect(result.err).toContain("--context");
    }
  });

  it("requires a policy to be resolvable", async () => {
    const result = await cli(["check", "user:alice", "document.read", "document:a"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("no policy file");
  });

  it("treats a malformed request tuple as a usage error, never as a DENY", async () => {
    const result = await acme(["user:alice", "document.read"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.code).not.toBe(EXIT.denied);
  });

  it("rejects a malformed subject at the boundary rather than denying silently", async () => {
    // `notanidentifier` does not match `type:id`; the evaluator rejects it at the
    // boundary (core ValidationError → exit 2). Never a silent DENY.
    const result = await acme(["notanidentifier", "document.read", "document:a"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("subject");
  });
});
