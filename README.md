# Universal Authorization Engine

A developer-friendly authorization engine: a reusable infrastructure primitive
that answers one question —

> **Can SUBJECT perform ACTION on RESOURCE under the current POLICY and CONTEXT?**

```
Subject + Action + Resource + Context + Relationships + Policy
        ↓
Authorization Decision + Explanation
```

## The problem it solves

Authorization logic today scatters across frontend, API, service, queue, and
database layers — each with slightly different rules and **no single
authoritative answer**. This engine aims to be the canonical decision point:
one policy, defined as code, tested like code, deployed like infrastructure,
and explainable after every decision.

Not an authentication provider — it never replaces identity providers; it
consumes identity information and decides what that identity may do.

## Core authorization model

| Concept      | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| Subject      | `user:alice`, `service:billing`, `agent:support-42`                              |
| Action       | `document.read`, `project.write`                                                 |
| Resource     | `document:123`, `project:alpha`                                                  |
| Context      | `{ "mfa": true, "time": "…" }` — data, never code                                |
| Relationship | `user:alice → member → organization:acme`                                        |
| Policy       | Which relationship/context combinations grant permissions (versioned, immutable) |

The fundamental representation is a relationship-oriented graph (ReBAC),
within which roles (RBAC) and attributes (ABAC) are expressible.
Governing invariant: **unknown → deny** (`docs/adr/0006-default-deny.md`).

## Minimal example (target API — not yet implemented)

```ts
const decision = await authz.check({
  subject: "user:alice",
  action: "document.delete",
  resource: "document:123",
});

if (!decision.allowed) {
  throw new ForbiddenError();
}
// Eventually: { allowed: true, policyVersion: "42", explanation: { … } }
```

## Implementation status

| Area                                                      | Status                         |
| --------------------------------------------------------- | ------------------------------ |
| Repository, tooling, CI, documentation                    | **Implemented**                |
| Domain model & core types (`@uae/core`)                   | **Implemented** (draft shapes) |
| Structured policy + versioned store (`@uae/policy`)       | **Implemented** (draft shapes) |
| In-memory evaluator + explanations (`@uae/evaluator`)     | **Implemented** (draft shapes) |
| Policy language v1, parser, AST, compiler (`@uae/policy`) | **Implemented** (v1 subset)    |
| CLI (`authz validate/test/check`)                         | Planned (Phase 4)              |
| SDK                                                       | Planned (Phase 5)              |
| Persistence, caching, benchmarks                          | Planned (Phases 6–7)           |
| Hosted / self-hosted service                              | Planned (Phase 8+)             |

No feature is claimed as implemented above unless it exists in this
repository. Full detail: `docs/development/roadmap.md`.

## Implemented path (today)

```ts
import { InMemoryPolicyStore } from "@uae/policy";
import { Evaluator, InMemoryRelationshipStore } from "@uae/evaluator";

// 1. Author policy in the language v1 (see examples/acme/policy.authz)
//    and publish it — text is parsed, lowered, validated, and compiled into an
//    immutable, content-hashed, versioned artifact.
const policyStore = new InMemoryPolicyStore();
const published = await policyStore.publishPolicy({ source: policyText, format: "text" });
policyStore.setActiveVersion(published.version); // activation is explicit

// 2. Supply relationships through the store interface (in-memory today).
const relationships = new InMemoryRelationshipStore();
relationships.add({ subject: "user:alice", relation: "owner", resource: "project:alpha" });

// 3. Evaluate deterministically, fail closed.
const evaluator = new Evaluator({
  policyStore,
  relationshipStore: relationships.asRelationshipStore(),
});
const decision = await evaluator.check({
  subject: "user:alice",
  action: "document.read",
  resource: "document:a",
});
// → { allowed: true, reason: "policy_allow", policyVersion: "1" }
```

An explanation can be requested per check
(`evaluator.check(req, { explanation: "standard" })`), and `checkBatch` evaluates
many requests with per-item fail-closed results.

## Development setup

Requires Node.js ≥ 18.14 and pnpm (Docker not required). In PowerShell:

```powershell
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

More: `docs/development/local-development.md`.

## Repository structure

```
├── .github/workflows/     CI (install → typecheck → lint → test → build)
├── docs/
│   ├── adr/               Architecture decision records
│   ├── architecture/      Overview, control/data plane, storage, caching, failure modes
│   ├── design/            Vision, domain model, authorization model, evaluation, explanations
│   ├── development/       Roadmap, local development, testing strategy
│   └── security/          Threat model, security principles
├── packages/
│   ├── core/              Domain types + store interfaces (zero dependencies)
│   ├── policy/            Policy language (lexer/parser/AST/lowering), validation, versioned store
│   ├── evaluator/         Deterministic evaluator + explanations
│   ├── sdk/               Planned — client API
│   └── cli/               Planned — authz CLI
├── examples/acme/         Canonical example domain (fixtures + policy.authz)
└── tests/                 Unit/integration/security tests
```

## Security considerations

- **Default deny**: unknown or errored evaluation is always DENY — never a
  silent allow. Denial is distinct from infrastructure failure.
- Tenant isolation, bounded traversal, and explicit failure modes are core
  properties, tested adversarially.
- See `docs/security/threat-model.md` and `docs/security/security-principles.md`.
  To report a vulnerability, see `SECURITY.md`.

## Contributing

Read `CONTRIBUTING.md`. In short: documentation and ADRs precede substantial
implementation; `main` stays buildable and green; descriptive commits;
default-deny is non-negotiable.

## License

[MIT](./LICENSE)
