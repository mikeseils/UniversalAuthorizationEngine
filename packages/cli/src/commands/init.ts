import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXIT, UsageError, type ExitCode } from "../errors.js";
import { hasFlag, type ParsedCommand } from "../args.js";
import type { CliIo } from "../io.js";
import { makeConsole } from "../render.js";

/**
 * `authz init [dir]` (ADR-0013).
 *
 * Writes a policy, a relationship file, a config, and an example test suite.
 * The full file set is computed first and the command refuses if **any** target
 * already exists (unless `--force`), so a scaffold is never half-applied and
 * nothing is silently overwritten.
 */

const CONFIG_JSON = `{
  "formatVersion": 1,
  "policy": "policy.authz",
  "relationships": "relationships.jsonl",
  "tests": ["tests"]
}
`;

const POLICY_AUTHZ = `// Authorization policy (language v1, ADR-0012).
// Declare who exists: relations are edges, permissions are derived checks.
// A traversal like \`organization.read\` uses the declared relation whose target
// type is \`organization\`; add \`via <edge>\` for incoming edges.

definition organization {
  relation admin: user
  relation member: user

  permission manage = admin
  permission read = admin or member
}

definition project {
  // The owning organization (incoming \`owns\` edge: org --owns--> project).
  relation organization: organization via owns
  relation owner: user
  relation editor: user
  relation viewer: user

  permission read = viewer or editor or owner or organization.read
  permission write = editor or owner
  permission delete = owner or organization.manage
}

definition document {
  // The containing project (incoming \`contains\` edge: project --contains--> doc).
  relation project: project via contains

  permission read = project.read
  permission delete = project.delete
}
`;

const RELATIONSHIPS_JSONL = `// Relationship data (ADR-0013): one JSON object per line.
{"formatVersion":1}
{"subject":"user:alice","relation":"admin","resource":"organization:acme"}
{"subject":"user:bob","relation":"member","resource":"organization:acme"}
{"subject":"organization:acme","relation":"owns","resource":"project:alpha"}
{"subject":"user:alice","relation":"owner","resource":"project:alpha"}
{"subject":"user:bob","relation":"viewer","resource":"project:alpha"}
{"subject":"project:alpha","relation":"contains","resource":"document:a"}
{"subject":"project:alpha","relation":"contains","resource":"document:b"}
`;

const TEST_AUTHZ = `// Policy tests (ADR-0014). \`deny\` means allowed === false AND
// reason === "policy_deny" — an evaluation error can never pass a deny test.
// Use \`== error\` when you intend to assert fail-closed behaviour.

test "alice owns project:alpha and may write it" {
  check(user:alice, project.write, project:alpha) == allow
}

test "bob only views project:alpha" {
  check(user:bob, project.read, project:alpha) == allow
  check(user:bob, project.write, project:alpha) == deny
  check(user:bob, project.delete, project:alpha) == deny
}

test "document permissions are inherited from the project" {
  check(user:alice, document.read, document:a) == allow
  check(user:alice, document.delete, document:a) == allow
  check(user:bob, document.read, document:a) == allow
  check(user:bob, document.delete, document:a) == deny
}

test "an unrelated user is denied" {
  check(user:carol, document.read, document:a) == deny
  check(user:carol, organization.read, organization:acme) == deny
}

test "a subject given project ownership may write" {
  given {
    user:carol owner project:alpha
  }
  check(user:carol, project.write, project:alpha) == allow
}
`;

export function runInit(command: ParsedCommand, io: CliIo): ExitCode {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const force = hasFlag(command, "--force");
  const target = resolve(io.cwd, command.positionals[0] ?? ".");
  const files: readonly { readonly path: string; readonly content: string }[] = [
    { path: join(target, "authz.json"), content: CONFIG_JSON },
    { path: join(target, "policy.authz"), content: POLICY_AUTHZ },
    { path: join(target, "relationships.jsonl"), content: RELATIONSHIPS_JSONL },
    { path: join(target, "tests", "acme.test.authz"), content: TEST_AUTHZ },
  ];

  const existing = files.filter((file) => existsSync(file.path));
  if (existing.length > 0 && !force) {
    throw new UsageError(
      `refusing to overwrite existing file(s):\n  ${existing
        .map((file) => file.path)
        .join("\n  ")}\nre-run with --force to overwrite`,
    );
  }

  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, "utf8");
    con.line(`created ${file.path}`);
  }
  con.line("");
  con.line("next steps:");
  con.line(
    `  authz validate --policy ${join(target, "policy.authz")} --relationships ${join(target, "relationships.jsonl")}`,
  );
  con.line(
    `  authz test --policy ${join(target, "policy.authz")} --relationships ${join(target, "relationships.jsonl")} ${join(target, "tests")}`,
  );
  return EXIT.ok;
}
