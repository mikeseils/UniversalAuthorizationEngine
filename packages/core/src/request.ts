import { Action } from "./action.js";
import { AuthorizationContext } from "./context.js";
import { Identifier } from "./identifiers.js";

/**
 * A complete authorization question:
 * "can SUBJECT perform ACTION on RESOURCE under CONTEXT?"
 * (docs/design/evaluation-model.md). DRAFT type — see API stability rules in
 * docs/architecture/api-boundaries.md before treating as stable.
 *
 * `subject` and `resource` accept **either** the authoring form (`"user:alice"`)
 * or the parsed form (`{ type: "user", id: "alice" }`); the evaluator normalizes
 * both. Both forms are supported because callers legitimately hold one or the
 * other (configuration/CLI text vs. already-parsed domain objects), matching the
 * convention `parseRelationship` already uses. The SDK phase will narrow this to
 * a single canonical form.
 */
export interface AuthorizationRequest {
  readonly subject: Identifier | string;
  readonly action: Action;
  readonly resource: Identifier | string;
  readonly context?: AuthorizationContext;
}
