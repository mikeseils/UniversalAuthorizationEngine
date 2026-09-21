import { Action } from "./action.js";
import { AuthorizationContext } from "./context.js";
import { Identifier } from "./identifiers.js";

/**
 * A complete authorization question:
 * "can SUBJECT perform ACTION on RESOURCE under CONTEXT?"
 * (docs/design/evaluation-model.md). DRAFT type — see API stability rules in
 * docs/architecture/api-boundaries.md before treating as stable.
 */
export interface AuthorizationRequest {
  readonly subject: Identifier;
  readonly action: Action;
  readonly resource: Identifier;
  readonly context?: AuthorizationContext;
}
