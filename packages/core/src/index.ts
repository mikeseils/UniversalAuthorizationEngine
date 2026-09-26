/**
 * @uae/core — domain model and interfaces for the Universal Authorization
 * Engine. Zero runtime dependencies by design (ADR-0005).
 *
 * All exported shapes are DRAFT: public APIs stabilize with the SDK phase,
 * and only after design reasoning is recorded in an ADR
 * (docs/architecture/api-boundaries.md).
 */
export { PolicyNotFoundError, ValidationError } from "./errors.js";
export type { Identifier } from "./identifiers.js";
export {
  formatIdentifier,
  isValidIdentifier,
  parseIdentifier,
  tryParseIdentifier,
} from "./identifiers.js";
export type { Resource, Subject } from "./principals.js";
export {
  assertIdentifier,
  coerceIdentifier,
  formatResource,
  formatSubject,
  isSubject,
  parseResource,
  parseSubject,
} from "./principals.js";
export type { Action } from "./action.js";
export { isValidAction, parseAction, tryParseAction } from "./action.js";
export type { AuthorizationContext } from "./context.js";
export type { Relationship, RelationshipQuery } from "./relationship.js";
export { parseRelationship, tryParseRelationship } from "./relationship.js";
export type { AuthorizationRequest } from "./request.js";
export type {
  AuthorizationDecision,
  DecisionReason,
  ExplanationLevel,
  ExplanationNode,
  ExplanationNodeKind,
  ExplanationOutcome,
} from "./decision.js";
export type { PolicySource, PolicyStore, RelationshipStore, VersionedPolicy } from "./stores.js";
