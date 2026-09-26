import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ParsedCommand, flagValue, hasFlag } from "./args.js";
import { CliConfig, findConfigFile, loadConfig, resolveFlagPath } from "./config.js";
import { UsageError } from "./errors.js";
import type { CliIo } from "./io.js";

/**
 * Path resolution and test discovery (ADR-0013): explicit flags beat
 * positional arguments, which beat `authz.json`; relative paths resolve
 * against the invocation cwd (flags/positionals) or the config directory
 * (config entries).
 */

export const TEST_FILE_SUFFIX = ".test.authz";

export function loadConfigIfPresent(io: CliIo): CliConfig | null {
  const file = findConfigFile(io.cwd);
  return file === null ? null : loadConfig(file);
}

export function resolvePolicyPath(
  io: CliIo,
  command: ParsedCommand,
  config: CliConfig | null,
  positional?: string,
): string {
  const flag = flagValue(command, "--policy");
  if (flag !== undefined) return resolveFlagPath(io.cwd, flag);
  if (positional !== undefined) return resolveFlagPath(io.cwd, positional);
  if (config?.policy != null) return config.policy;
  throw new UsageError(
    'no policy file: pass a path (or --policy <file>), or add "policy" to authz.json',
  );
}

export function resolveRelationshipsPath(
  io: CliIo,
  command: ParsedCommand,
  config: CliConfig | null,
): string | null {
  const flag = flagValue(command, "--relationships");
  if (flag !== undefined) return resolveFlagPath(io.cwd, flag);
  return config?.relationships ?? null;
}

/**
 * Discover test files: explicit positionals (files or directories) or the
 * config's `tests` entries; directories are scanned recursively for
 * `*.test.authz`. Results are sorted so output order is deterministic.
 */
export function discoverTestFiles(
  io: CliIo,
  command: ParsedCommand,
  config: CliConfig | null,
): readonly string[] {
  const entries =
    command.positionals.length > 0
      ? command.positionals.map((positional) => resolveFlagPath(io.cwd, positional))
      : [...(config?.tests ?? [])];

  if (entries.length === 0) {
    throw new UsageError(
      'no tests configured: pass a file or directory, or add "tests" to authz.json',
    );
  }

  const found = new Set<string>();
  for (const entry of entries) {
    let stats;
    try {
      stats = statSync(entry);
    } catch {
      throw new UsageError(`test path not found: ${entry}`);
    }
    if (stats.isDirectory()) {
      collectTestFiles(entry, found);
    } else {
      found.add(entry);
    }
  }
  if (found.size === 0) {
    throw new UsageError(`no ${TEST_FILE_SUFFIX} files found in ${entries.join(", ")}`);
  }
  return [...found].sort();
}

function collectTestFiles(dir: string, into: Set<string>): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, into);
    } else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) {
      into.add(full);
    }
  }
}

/** Whether `--no-color` was requested. */
export function noColor(command: ParsedCommand): boolean {
  return hasFlag(command, "--no-color");
}
