# ADR-0015: Client request normalization and identifier references

- Status: Accepted
- Date: 2026-09-25
- Context: Phase 5 (TypeScript SDK). In Phase 0-2, `AuthorizationRequest` required
  parsed `Identifier` objects for `subject` and `resource`. That forced every
  caller (CLI, application service, tests) to parse strings prior to calling the engine.
  In Phase 4, `coerceIdentifier` was added to `core`. ADR-0015 codifies the client
  boundary normalization rules.

## Decision

1. **Accept both string and object forms at the public client boundary**:
   Callers may pass `subject` and `resource` either as a formatted string (e.g.,
   `"user:alice"`, `"document:budget-2026"`) or as a structured object
   (`{ type: "user", id: "alice" }`).
   - String format: `<type>:<id>`, matching `parseIdentifier` / `IDENT_PATTERN`.
   - Object format: `{ type: string, id: string }` validated against identifier rules.

2. **Validation occurs immediately at the client entry point**:
   Malformed identifiers (empty type, empty id, missing separator, invalid characters)
   throw a typed `ValidationError` from `@uae/core` **synchronously** or at the
   client boundary before any network or transport dispatch occurs.

3. **No silent coercion or lenient parsing**:
   Consistent with ADR-0006 (default-deny and strict fail-closed), the SDK never
   coerces unknown shapes into defaults or trims invalid characters silently.
   Invalid inputs fail hard and early.

## Consequences

- Applications can author clean, idiomatic calls like
  `client.check({ subject: "user:alice", action: "document.read", resource: "document:123" })`
  without manual parsing boilerplate.
- Batch requests validate each element's identifiers prior to submission, throwing
  `ValidationError` before partial dispatch.
