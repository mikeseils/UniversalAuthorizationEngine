import { formatIdentifier, Identifier, isValidIdentifier, parseIdentifier } from "./identifiers.js";
import { ValidationError } from "./errors.js";

/**
 * An entity requesting an operation (docs/design/domain-model.md § Subject).
 * DRAFT type.
 */
export type Subject = Identifier;

/** Parse a subject reference such as `user:alice` or `agent:support-42`. */
export function parseSubject(input: unknown): Subject {
  return parseIdentifier(input);
}

/** Format a subject back to its `type:id` string form. */
export function formatSubject(subject: Subject): string {
  return formatIdentifier(subject);
}

/** Type guard for subject reference strings. */
export function isSubject(input: unknown): input is string {
  return isValidIdentifier(input);
}

/**
 * An entity being accessed (docs/design/domain-model.md § Resource).
 * DRAFT type.
 */
export type Resource = Identifier;

/** Parse a resource reference such as `document:456`. */
export function parseResource(input: unknown): Resource {
  return parseIdentifier(input);
}

/** Format a resource back to its `type:id` string form. */
export function formatResource(resource: Resource): string {
  return formatIdentifier(resource);
}

/** Validate a structurally-typed subject/resource value (not a string). */
export function assertIdentifier(value: unknown, field: string): Identifier {
  if (typeof value !== "object" || value === null) {
    throw new ValidationError(field, "must be an object with type and id");
  }
  const candidate = value as Record<string, unknown>;
  const type = candidate["type"];
  const id = candidate["id"];
  if (typeof type !== "string" || !isValidIdentifier(type + ":x")) {
    throw new ValidationError(`${field}.type`, "invalid identifier type");
  }
  if (typeof id !== "string" || id.length === 0 || /[:\s]/.test(id)) {
    throw new ValidationError(`${field}.id`, "invalid identifier id");
  }
  return Object.freeze({ type, id });
}

/**
 * Accept either form of a reference — the `type:id` string or the structured
 * `{ type, id }` — and return the parsed form. `field` names the offending part
 * in the error so callers can report *which* input was malformed.
 *
 * Used at request boundaries (both forms are legitimately held by callers);
 * strict `parseIdentifier` stays the default everywhere else.
 */
export function coerceIdentifier(value: unknown, field: string): Identifier {
  try {
    return typeof value === "string" ? parseIdentifier(value) : assertIdentifier(value, field);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(field, error.message);
    }
    throw error;
  }
}
