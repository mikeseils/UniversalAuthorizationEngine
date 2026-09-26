import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { UsageError } from "./errors.js";

/**
 * `authz.json` discovery and loading (ADR-0013).
 *
 * - `formatVersion` is required and must be 1.
 * - Unknown top-level keys are rejected: a typo such as `"policies"` must not
 *   silently change behavior.
 * - Relative paths resolve against the config file's directory, so results do
 *   not depend on the directory the command was invoked from.
 */

export const CONFIG_FILENAME = "authz.json";
export const CONFIG_FORMAT_VERSION = 1;

export interface CliConfig {
  /** Absolute path of the config file. */
  readonly file: string;
  /** Absolute directory the config lives in (path base). */
  readonly dir: string;
  /** Absolute policy path, or null when the config omits it. */
  readonly policy: string | null;
  /** Absolute relationship data path, or null when the config omits it. */
  readonly relationships: string | null;
  /** Absolute test file/directory entries (may be empty). */
  readonly tests: readonly string[];
}

const KNOWN_KEYS = new Set(["formatVersion", "policy", "relationships", "tests"]);

/** Nearest `authz.json` at or above `cwd`, or null. */
export function findConfigFile(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(file: string): CliConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read config ${file}: ${reason(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`config ${file} is not valid JSON: ${reason(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`config ${file} must be a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new UsageError(
        `config ${file}: unknown key "${key}" (known keys: ${[...KNOWN_KEYS].join(", ")})`,
      );
    }
  }
  const version = raw["formatVersion"];
  if (version !== CONFIG_FORMAT_VERSION) {
    throw new UsageError(
      `config ${file}: formatVersion must be ${String(CONFIG_FORMAT_VERSION)} (got ${JSON.stringify(version)})`,
    );
  }

  const dir = dirname(resolve(file));
  return {
    file: resolve(file),
    dir,
    policy: optionalPath(raw["policy"], "policy", dir),
    relationships: optionalPath(raw["relationships"], "relationships", dir),
    tests: testEntries(raw["tests"], dir),
  };
}

function optionalPath(value: unknown, key: string, dir: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`config key "${key}" must be a non-empty string path`);
  }
  return isAbsolute(value) ? resolve(value) : resolve(dir, value);
}

function testEntries(value: unknown, dir: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new UsageError(`config key "tests" must be an array of paths`);
  }
  return (value as string[]).map((entry) =>
    isAbsolute(entry) ? resolve(entry) : resolve(dir, entry),
  );
}

/** `--flag` value, resolved against the invocation cwd. */
export function resolveFlagPath(cwd: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
