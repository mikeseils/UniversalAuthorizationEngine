import { ValidationError } from "./errors.js";

/**
 * A parsed `type:id` identifier (see docs/design/domain-model.md § Identifiers).
 * DRAFT type — shape may change before the SDK stabilizes it (ADR pending).
 */
export interface Identifier {
  /** Lowercase kebab-case entity type, e.g. `user`, `document`. */
  readonly type: string;
  /** Opaque, non-empty id containing no whitespace and no `:`. */
  readonly id: string;
}

const TYPE_RE = /^[a-z][a-z0-9_-]*$/;
const ID_RE = /^[^:\s]+$/;

/**
 * Parse a `type:id` string such as `user:alice`.
 * Throws {@link ValidationError} on any malformed input.
 */
export function parseIdentifier(input: unknown): Identifier {
  if (typeof input !== "string") {
    throw new ValidationError("identifier", "must be a string");
  }
  const separator = input.indexOf(":");
  if (separator < 0) {
    throw new ValidationError("identifier", `missing ':' separator (got ${JSON.stringify(input)})`);
  }
  const type = input.slice(0, separator);
  const id = input.slice(separator + 1);
  if (!TYPE_RE.test(type)) {
    throw new ValidationError(
      "identifier.type",
      `invalid type ${JSON.stringify(type)}; expected [a-z][a-z0-9_-]*`,
    );
  }
  if (!ID_RE.test(id)) {
    throw new ValidationError(
      "identifier.id",
      `invalid id ${JSON.stringify(id)}; must be non-empty without ':' or whitespace`,
    );
  }
  return Object.freeze({ type, id });
}

/** Like {@link parseIdentifier} but returns `null` instead of throwing. */
export function tryParseIdentifier(input: unknown): Identifier | null {
  try {
    return parseIdentifier(input);
  } catch {
    return null;
  }
}

/** Format an identifier back to its `type:id` string form. */
export function formatIdentifier(identifier: Identifier): string {
  return `${identifier.type}:${identifier.id}`;
}

/** Type guard: does this look like a valid `type:id` string? */
export function isValidIdentifier(input: unknown): input is string {
  return tryParseIdentifier(input) !== null;
}
