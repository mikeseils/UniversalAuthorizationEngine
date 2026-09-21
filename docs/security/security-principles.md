# Security Principles

Binding for all phases. See also ADR-0006 (default-deny) and
`threat-model.md`.

1. **Default deny.** `unknown → deny`. Missing relationships, unavailable
   attributes, and evaluation errors never produce ALLOW. Exceptions require
   an ADR and explicit tests.
2. **Explicit behavior.** No undocumented implicit behavior in security-
   sensitive operations. Every ambiguity is documented and tested.
3. **Determinism.** Same inputs → same decision and explanation. Evaluation
   is pure: no network, clock, randomness, or I/O.
4. **Bounded execution.** Traversal depth/fan-out, request sizes, and batch
   sizes are limited; pathological inputs degrade to explained DENY.
5. **Explicit failure.** DENY is distinct from infrastructure failure
   (AUTHZ_UNAVAILABLE). The engine is fail-closed; applications choose their
   availability behavior explicitly.
6. **Tenant isolation is a core property.** Relationships and policies are
   tenant-scoped; cross-tenant access requires explicit, auditable policy
   support. Validated statically (eventually) and tested adversarially
   (always).
7. **Immutability & provenance.** Policies are immutable, versioned artifacts;
   decisions can cite the exact version. No silent policy mutation.
8. **Least privilege in the engine itself.** The engine knows as little as
   possible: PII minimization (opaque subject IDs, no names/emails required);
   explanations obey disclosure levels; observability obeys privacy
   constraints.
9. **Small, inspectable core.** Prefer a language and evaluator that can be
   formally understood, statically analyzed, and verified over expressive
   power.
10. **Control-plane / data-plane trust boundary.** The data plane verifies
    signed policy artifacts; a compromised management surface cannot silently
    change production authorization.
