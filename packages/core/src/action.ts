import { ValidationError } from "./errors.js";

/**
 * An operation being requested (docs/design/domain-model.md § Action).
 * Current direction: dotted, type-scoped strings such as `document.read`.
 * A flat or structured variant may replace this before the policy-language
 * ADR finalizes action syntax (ADR-0008 follow-up). DRAFT type.
 */
export type Action = string;

const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/**
 * Validate an action string (`read`, `document.read`).
 * Throws {@link ValidationError} on malformed input.
 */
export function parseAction(input: unknown): Action {
  if (typeof input !== "string" || !ACTION_RE.test(input)) {
    throw new ValidationError(
      "action",
      `invalid action ${JSON.stringify(input)}; expected lowercase dotted segments like "document.read"`,
    );
  }
  return input;
}

/** Like {@link parseAction} but returns `null` instead of throwing. */
export function tryParseAction(input: unknown): Action | null {
  try {
    return parseAction(input);
  } catch {
    return null;
  }
}

/** Type guard for action strings. */
export function isValidAction(input: unknown): input is Action {
  return tryParseAction(input) !== null;
}
