import { createHash } from "node:crypto";
import { StructuredPolicy } from "./structured-policy.js";

/**
 * The evaluator-facing compiled artifact: validated, frozen, content-hashed.
 * The artifact body is the structured policy itself in Phase 2; Phase 3's
 * compiler may optimize this representation without changing the interface.
 */
export interface CompiledPolicyArtifact {
  readonly definitions: StructuredPolicy["definitions"];
}

export interface CompiledPolicy {
  readonly artifact: CompiledPolicyArtifact;
  readonly hash: string;
}

/** Canonical JSON: recursively sorted object keys, stable ordering. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Compile a *validated* structured policy into an immutable, hashed artifact.
 * Callers must run {@link validateStructuredPolicy} first; compilation of an
 * invalid source is a programming error.
 */
export function compileStructuredPolicy(source: StructuredPolicy): CompiledPolicy {
  const artifact: CompiledPolicyArtifact = Object.freeze({
    definitions: deepFreeze(source.definitions),
  });
  const hash = createHash("sha256").update(canonicalJson(artifact)).digest("hex");
  return { artifact, hash };
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (typeof value === "object" && value !== null) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Structural re-check applied to loaded artifacts at evaluation time. */
export function isCompiledArtifactShape(value: unknown): value is CompiledPolicyArtifact {
  if (typeof value !== "object" || value === null) return false;
  const definitions = (value as Record<string, unknown>)["definitions"];
  if (typeof definitions !== "object" || definitions === null) return false;
  return Object.values(definitions as Record<string, unknown>).every((def) => {
    if (typeof def !== "object") return false;
    const d = def as Record<string, unknown>;
    return d["relations"] !== null && d["permissions"] !== null;
  });
}
