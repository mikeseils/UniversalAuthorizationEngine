/**
 * @uae/sdk — TypeScript client SDK for the Universal Authorization Engine.
 *
 * Implements the client boundary with discrete outcome taxonomy (decision vs unavailable),
 * ergonomic request handling, per-item batch isolation, and transport abstraction (ADR-0015, ADR-0016).
 */

export { AuthzClient, normalizeClientRequest } from "./client.js";
export type { InMemoryClientOptions } from "./client.js";

export { AuthorizationUnavailableError, ValidationError } from "./errors.js";
export type { UnavailableReason } from "./errors.js";

export { InProcessTransport, toUnavailableError } from "./transport.js";
export type { ClientTransport } from "./transport.js";

export type {
  AuthorizationDecisionOutcome,
  AuthorizationUnavailableOutcome,
  CheckOutcome,
  ClientCheckOptions,
  ClientRequest,
  IsAllowedOptions,
  ResourceRef,
  SubjectRef,
} from "./types.js";
