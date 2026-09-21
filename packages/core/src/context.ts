/**
 * Additional request information (docs/design/domain-model.md § Context).
 *
 * Binding constraints:
 * - Context is DATA, never executable logic; the evaluator must never treat
 *   context values as code (no expression strings, no callbacks).
 * - Context is untrusted input; policies must declare which keys they use and
 *   how they are validated before conditions may depend on them (Phase 2+).
 * - A missing/unavailable context attribute makes any condition that depends
 *   on it NOT satisfied (default-deny, ADR-0006).
 * DRAFT type.
 */
export type AuthorizationContext = Readonly<Record<string, unknown>>;
