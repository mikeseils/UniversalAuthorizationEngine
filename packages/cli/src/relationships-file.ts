import { readFileSync } from "node:fs";
import { Relationship, parseRelationship } from "@uae/core";
import { reason } from "./config.js";
import { UsageError } from "./errors.js";

/**
 * Relationship data files (`*.jsonl`, ADR-0013):
 *
 * ```
 * // comments and blank lines are allowed
 * {"formatVersion":1}
 * {"subject":"user:alice","relation":"admin","resource":"organization:acme"}
 * ```
 *
 * The optional `formatVersion` directive declares the format explicitly;
 * absence means version 1. Every relationship line must have exactly
 * `subject`, `relation`, and `resource` — unknown or missing keys are errors,
 * because silently ignoring a typo in a security-relevant data file is how
 * access gets granted by accident.
 */

export const RELATIONSHIPS_FORMAT_VERSION = 1;

export interface RelationshipsLoadResult {
  /** Successfully parsed relationships, in file order. */
  readonly relationships: readonly Relationship[];
  /** Line-numbered error messages; empty means the whole file is valid. */
  readonly errors: readonly string[];
}

const REQUIRED_KEYS = ["subject", "relation", "resource"] as const;

/** Read + parse a relationship file. Unreadable file → usage error (exit 2). */
export function readRelationshipsFile(file: string): RelationshipsLoadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read relationship file ${file}: ${reason(error)}`);
  }
  return parseRelationshipsJsonl(text, file);
}

export function parseRelationshipsJsonl(text: string, label: string): RelationshipsLoadResult {
  const relationships: Relationship[] = [];
  const errors: string[] = [];
  let seenDirective = false;
  let seenRelationship = false;

  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim();
    const where = `${label}:${String(index + 1)}`;
    if (line === "" || line.startsWith("//")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push(`${where}: not valid JSON (${reason(error)})`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push(`${where}: expected a JSON object`);
      continue;
    }
    const raw = parsed as Record<string, unknown>;

    if (!seenDirective && !seenRelationship && "formatVersion" in raw) {
      seenDirective = true;
      const version = raw["formatVersion"];
      if (version !== RELATIONSHIPS_FORMAT_VERSION) {
        errors.push(
          `${where}: unsupported formatVersion ${JSON.stringify(version)} (expected ${String(RELATIONSHIPS_FORMAT_VERSION)})`,
        );
      }
      continue;
    }

    const missing = REQUIRED_KEYS.filter((key) => !(key in raw));
    const unknown = Object.keys(raw).filter(
      (key) => !(REQUIRED_KEYS as readonly string[]).includes(key),
    );
    if (missing.length > 0) {
      errors.push(`${where}: missing ${missing.map((key) => `"${key}"`).join(", ")}`);
      continue;
    }
    if (unknown.length > 0) {
      errors.push(`${where}: unknown ${unknown.map((key) => `"${key}"`).join(", ")}`);
      continue;
    }

    seenRelationship = true;
    try {
      relationships.push(parseRelationship(raw));
    } catch (error) {
      errors.push(`${where}: ${reason(error)}`);
    }
  }

  return { relationships, errors };
}
