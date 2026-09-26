import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  EXIT,
  HelpRequested,
  UsageError,
  commandUsage,
  parseArgs,
  usageText,
} from "../packages/cli/src/index.js";

/** Parse argv that must resolve to a command (fails loudly otherwise). */
function command(argv: readonly string[]) {
  const parsed = parseArgs(argv);
  if (parsed.kind !== "command") throw new Error(`expected a command for ${argv.join(" ")}`);
  return parsed.command;
}

describe("CLI argument parsing (ADR-0013)", () => {
  it("exposes the documented exit-code contract", () => {
    expect(EXIT).toEqual({ ok: 0, validation: 1, usage: 2, denied: 3, infrastructure: 4 });
  });

  it("treats no command, --help, -h, and help as help", () => {
    for (const argv of [[], ["--help"], ["-h"], ["help"]] as const) {
      const parsed = parseArgs(argv);
      expect(parsed.kind, argv.join(" ")).toBe("help");
    }
  });

  it("prints every command and the exit codes in the global usage text", () => {
    const text = usageText();
    for (const spec of COMMANDS) {
      expect(text).toContain(spec.name);
      expect(text).toContain(spec.usage);
    }
    expect(text).toContain(
      "Exit codes: 0 ok, 1 validation/test failure, 2 usage, 3 deny, 4 infrastructure",
    );
  });

  it("documents each flag in per-command usage", () => {
    const validate = COMMANDS.find((spec) => spec.name === "validate");
    if (validate === undefined) throw new Error("validate command is missing");
    const text = commandUsage(validate);
    expect(text).toContain("--policy <file>");
    expect(text).toContain("--relationships <file>");
    expect(text).toContain("--strict");
  });

  it("rejects an unknown command", () => {
    expect(() => parseArgs(["deploy"])).toThrow(UsageError);
    expect(() => parseArgs(["deploy"])).toThrow(/unknown command "deploy"/);
  });

  it("treats --help after a command as a help request, not an error", () => {
    expect(() => parseArgs(["validate", "--help"])).toThrow(HelpRequested);
    expect(() => parseArgs(["check", "-h"])).toThrow(HelpRequested);
  });

  it("accepts string flags in both separated and inline forms", () => {
    expect(command(["validate", "--policy", "p.authz"]).flags.get("--policy")).toBe("p.authz");
    expect(command(["validate", "--policy=p.authz"]).flags.get("--policy")).toBe("p.authz");
    expect(
      command(["check", "s", "a", "r", "--context", '{"mfa":true}']).flags.get("--context"),
    ).toBe('{"mfa":true}');
  });

  it("collects positionals in order", () => {
    const parsed = command(["check", "user:alice", "document.read", "document:a"]);
    expect(parsed.positionals).toEqual(["user:alice", "document.read", "document:a"]);
    expect(parsed.spec.name).toBe("check");
  });

  it("requires a value for string flags", () => {
    expect(() => parseArgs(["validate", "--policy"])).toThrow(/requires a <file>/);
    // A following flag is not swallowed as the value.
    expect(() => parseArgs(["validate", "--policy", "--strict"])).toThrow(/requires a <file>/);
  });

  it("rejects a value on boolean flags", () => {
    expect(() => parseArgs(["validate", "--strict=1"])).toThrow(/does not take a value/);
  });

  it("rejects unknown flags, naming the command", () => {
    expect(() => parseArgs(["validate", "--polcy", "x"])).toThrow(/unknown flag "--polcy"/);
    expect(() => parseArgs(["validate", "--polcy", "x"])).toThrow(/authz validate/);
  });

  it("stops flag parsing at -- (everything after is positional)", () => {
    const parsed = command(["validate", "--", "--strict"]);
    expect(parsed.positionals).toEqual(["--strict"]);
    expect(parsed.flags.has("--strict")).toBe(false);
  });

  it("enforces positional arity per command", () => {
    expect(() => parseArgs(["check", "user:alice"])).toThrow(UsageError);
    expect(() => parseArgs(["check", "s", "a", "r", "extra"])).toThrow(UsageError);
    expect(() => parseArgs(["validate", "a.b.authz", "b.authz"])).toThrow(UsageError);
    // `test` takes any number of paths; `init` takes at most one directory.
    expect(command(["test", "a", "b", "c"]).positionals).toHaveLength(3);
    expect(command(["init"]).positionals).toHaveLength(0);
    expect(command(["init", "sub/dir"]).positionals).toEqual(["sub/dir"]);
    expect(() => parseArgs(["init", "a", "b"])).toThrow(UsageError);
  });

  it("reports the expected positional shape when arity fails", () => {
    expect(() => parseArgs(["check"])).toThrow(/<subject> <action> <resource>/);
  });
});
