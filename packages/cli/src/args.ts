import { HelpRequested, UsageError } from "./errors.js";

/**
 * Spec-driven argv parsing (ADR-0013). No CLI framework: the surface is small
 * enough that a dependency would add supply-chain risk and non-deterministic
 * formatting for no benefit.
 *
 * Rules:
 * - `--flag` (boolean), `--flag value` or `--flag=value` (string);
 * - `--` ends flag parsing, everything after is positional;
 * - unknown flags, missing values, and unexpected positionals are usage errors;
 * - boolean flags are only ever present (`true`) or absent — negations such as
 *   `--no-fail-on-deny` are their own flags, so there is no tri-state logic.
 */

export interface FlagSpec {
  readonly name: string;
  readonly kind: "boolean" | "string";
  readonly value?: string;
  readonly description: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly flags: readonly FlagSpec[];
  readonly minPositionals: number;
  readonly maxPositionals: number | null;
  readonly positionalName: string;
}

const NO_COLOR_FLAG: FlagSpec = {
  name: "--no-color",
  kind: "boolean",
  description: "disable ANSI color",
};

const POLICY_FLAG: FlagSpec = {
  name: "--policy",
  kind: "string",
  value: "file",
  description: "policy file (overrides authz.json)",
};

const RELATIONSHIPS_FLAG: FlagSpec = {
  name: "--relationships",
  kind: "string",
  value: "file",
  description: "relationship file (overrides authz.json)",
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "Scaffold a policy, relationship file, config, and example tests",
    usage: "authz init [dir] [--force]",
    flags: [
      { name: "--force", kind: "boolean", description: "overwrite existing files" },
      NO_COLOR_FLAG,
    ],
    minPositionals: 0,
    maxPositionals: 1,
    positionalName: "[dir]",
  },
  {
    name: "validate",
    summary: "Validate a policy file (and optionally relationship data)",
    usage: "authz validate [policyFile] [--relationships file] [--strict] [--json]",
    flags: [
      POLICY_FLAG,
      RELATIONSHIPS_FLAG,
      { name: "--strict", kind: "boolean", description: "treat warnings as errors" },
      { name: "--json", kind: "boolean", description: "machine-readable output" },
      NO_COLOR_FLAG,
    ],
    minPositionals: 0,
    maxPositionals: 1,
    positionalName: "[policyFile]",
  },
  {
    name: "test",
    summary: "Run policy tests (*.test.authz)",
    usage: "authz test [file|dir ...] [--policy file] [--relationships file] [--json]",
    flags: [
      POLICY_FLAG,
      RELATIONSHIPS_FLAG,
      { name: "--json", kind: "boolean", description: "machine-readable output" },
      NO_COLOR_FLAG,
    ],
    minPositionals: 0,
    maxPositionals: null,
    positionalName: "[file|dir ...]",
  },
  {
    name: "check",
    summary: "Evaluate one authorization request",
    usage:
      "authz check <subject> <action> <resource> [--context json] [--explain level] [--policy file] [--relationships file] [--json] [--no-fail-on-deny]",
    flags: [
      { name: "--context", kind: "string", value: "json", description: "request context JSON" },
      {
        name: "--explain",
        kind: "string",
        value: "level",
        description: "none|minimal|standard|debug",
      },
      POLICY_FLAG,
      RELATIONSHIPS_FLAG,
      { name: "--json", kind: "boolean", description: "machine-readable output" },
      {
        name: "--no-fail-on-deny",
        kind: "boolean",
        description: "exit 0 for DENY instead of 3",
      },
      NO_COLOR_FLAG,
    ],
    minPositionals: 3,
    maxPositionals: 3,
    positionalName: "<subject> <action> <resource>",
  },
];

export interface ParsedCommand {
  readonly spec: CommandSpec;
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
}

export type ParseResult =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "command"; readonly command: ParsedCommand };

export function usageText(): string {
  const lines = ["authz — Universal Authorization Engine CLI", "", "Usage:"];
  for (const command of COMMANDS) {
    lines.push(`  ${command.usage}`);
  }
  lines.push("", "Commands:");
  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(10)} ${command.summary}`);
  }
  lines.push("", "Exit codes: 0 ok, 1 validation/test failure, 2 usage, 3 deny, 4 infrastructure");
  return lines.join("\n");
}

export function commandUsage(command: CommandSpec): string {
  const lines = [`usage: ${command.usage}`, "", command.summary, ""];
  if (command.flags.length > 0) {
    lines.push("Flags:");
    for (const flag of command.flags) {
      const value = flag.kind === "string" ? ` <${flag.value ?? "value"}>` : "";
      lines.push(`  ${`${flag.name}${value}`.padEnd(28)} ${flag.description}`);
    }
  }
  return lines.join("\n");
}

export function hasFlag(command: ParsedCommand, name: string): boolean {
  return command.flags.get(name) === true;
}
/** Parse argv (excluding the executable and script path). */
export function parseArgs(argv: readonly string[]): ParseResult {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    return { kind: "help", text: usageText() };
  }
  const spec = COMMANDS.find((command) => command.name === first);
  if (spec === undefined) {
    throw new UsageError(`unknown command "${first}"`);
  }
  return { kind: "command", command: parseCommand(spec, argv.slice(1)) };
}

function parseCommand(spec: CommandSpec, rest: readonly string[]): ParsedCommand {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let onlyPositionals = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (onlyPositionals) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositionals = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new HelpRequested(commandUsage(spec));
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const inlineValue = equals < 0 ? undefined : arg.slice(equals + 1);
    const flagSpec = spec.flags.find((flag) => flag.name === name);
    if (flagSpec === undefined) {
      throw new UsageError(`unknown flag "${name}" for \`authz ${spec.name}\``);
    }
    if (flagSpec.kind === "boolean") {
      if (inlineValue !== undefined) {
        throw new UsageError(`flag "${name}" does not take a value`);
      }
      flags.set(name, true);
      continue;
    }
    const value = inlineValue ?? rest[i + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
      throw new UsageError(`flag "${name}" requires a <${flagSpec.value ?? "value"}>`);
    }
    if (inlineValue === undefined) i += 1;
    flags.set(name, value);
  }

  const tooFew = positionals.length < spec.minPositionals;
  const tooMany = spec.maxPositionals !== null && positionals.length > spec.maxPositionals;
  if (tooFew || tooMany) {
    throw new UsageError(
      `\`authz ${spec.name}\` expects ${spec.positionalName}\n\n${commandUsage(spec)}`,
    );
  }
  return { spec, flags, positionals };
}

export function flagValue(command: ParsedCommand, name: string): string | undefined {
  const value = command.flags.get(name);
  return typeof value === "string" ? value : undefined;
}
