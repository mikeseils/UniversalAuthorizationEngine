import { Identifier, isValidIdentifier, parseIdentifier } from "./identifiers.js";
import { ValidationError } from "./errors.js";

/**
 * A typed edge between entities (docs/design/domain-model.md § Relationship).
 *
 * `{ subject: "user:alice", relation: "member", resource: "organization:acme" }`
 *
 * Relations are names defined by the policy schema (e.g. `member`, `editor`,
 * `owner`, `contains`, `acts_on_behalf_of`). Relationships are tenant-scoped;
 * cross-tenant edges are invalid unless policy explicitly allows sharing.
 * DRAFT type.
 */
export interface Relationship {
  readonly subject: Identifier;
  /** Relation name defined by the policy schema. */
  readonly relation: string;
  readonly resource: Identifier;
}

const RELATION_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate a relationship record. Subject and resource may be given as
 * `type:id` strings or `{ type, id }` objects; malformed values throw
 * {@link ValidationError}.
 */
export function parseRelationship(input: unknown): Relationship {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("relationship", "must be an object");
  }
  const raw = input as Record<string, unknown>;
  const subject = validateRef(raw["subject"], "relationship.subject");
  const resource = validateRef(raw["resource"], "relationship.resource");
  const relation = raw["relation"];
  if (typeof relation !== "string" || !RELATION_RE.test(relation)) {
    throw new ValidationError(
      "relationship.relation",
      `invalid relation ${JSON.stringify(relation)}; expected [a-z][a-z0-9_]*`,
    );
  }
  return Object.freeze({ subject, relation, resource });
}

function validateRef(value: unknown, field: string): Identifier {
  if (typeof value === "string") {
    return parseIdentifier(value);
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    if (isValidIdentifier(`${String(candidate["type"])}:${String(candidate["id"])}`)) {
      return Object.freeze({ type: String(candidate["type"]), id: String(candidate["id"]) });
    }
  }
  throw new ValidationError(field, "must be a `type:id` string or { type, id } object");
}

/** Like {@link parseRelationship} but returns `null` instead of throwing. */
export function tryParseRelationship(input: unknown): Relationship | null {
  try {
    return parseRelationship(input);
  } catch {
    return null;
  }
}

/**
 * Query filter for a {@link RelationshipStore}. Any field may be omitted to
 * match "all values" for that position.
 */
export interface RelationshipQuery {
  readonly subject?: Identifier;
  readonly relation?: string;
  readonly resource?: Identifier;
}
