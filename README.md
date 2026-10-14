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

## Minimal example

```ts
import { AuthzClient } from "@uae/sdk";

const authz = await AuthzClient.inMemory({
  policy: policyText,
  relationships: [{ subject: "user:alice", relation: "owner", resource: "project:alpha" }],
});

const result = await authz.check({
  subject: "user:alice",
  action: "document.delete",
  resource: "document:123",
});

if (result.outcome === "unavailable") {
  // The engine could not answer. This is NOT a denial — decide explicitly.
  throw result.error;
}
if (!result.decision.allowed) {
  throw new ForbiddenError();
}
```

## Implementation status

| Area                                                          | Status                         |
| ------------------------------------------------------------- | ------------------------------ |
| Repository, tooling, CI, documentation                        | **Implemented**                |
| Domain model & core types (`@uae/core`)                       | **Implemented** (draft shapes) |
| Structured policy + versioned store (`@uae/policy`)           | **Implemented** (draft shapes) |
| In-memory evaluator + explanations (`@uae/evaluator`)         | **Implemented** (draft shapes) |
| Policy language v1, parser, AST, compiler (`@uae/policy`)     | **Implemented** (v1 subset)    |
| CLI (`authz validate/test/check/init`)                        | **Implemented** (Phase 4)      |
| SDK (`@uae/sdk`: `check`, `checkBatch`, decision/unavailable) | **Implemented** (Phase 5)      |
| PostgreSQL stores (`@uae/persistence`) + store contract       | **Implemented** (Phase 6)      |
| Caching, decision-cache invalidation                          | Planned (Phase 7)              |
| Hosted / self-hosted service                                  | Planned (Phase 8+)             |

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
// Activation is explicit and always awaited: publishing never deploys, and a
// persistent store's activation is asynchronous (ADR-0018 S7).
await policyStore.setActiveVersion(published.version);

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

## SDK (`@uae/sdk`)

Applications should not wire up stores and the evaluator themselves. The SDK is
the supported client surface:

```ts
// A denial and an engine outage are different things, and stay different things.
const allowed = await authz.isAllowed({ subject, action, resource });
// ^ throws AuthorizationUnavailableError on infrastructure failure.
// ^ pass { onUnavailable: "deny" } to fail closed to `false` instead.
// ^ there is no option that fails open.

const outcomes = await authz.checkBatch([req1, req2, req3]);
// 1:1 with the input; one unavailable item never invalidates its siblings.
```

Wrap an existing `Evaluator` with `AuthzClient.fromEvaluator(evaluator)`, or
construct a ready-to-use client with `AuthzClient.inMemory({ policy, relationships })`.
Transports are pluggable (`ClientTransport`), so the same client code works
in-process today and against a remote data plane later. Design: ADR-0015, ADR-0016.

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
│   ├── sdk/               TypeScript SDK: stable client API, decision/unavailable outcomes
│   ├── cli/               authz CLI: init, validate, test, check
│   └── persistence/       PostgreSQL relationship + policy stores, SQL migrations
├── examples/acme/         Canonical example domain (policy, relationships, tests)
├── scripts/bench.mjs      Access-pattern benchmark (pnpm bench)
└── tests/                 Engine, CLI, SDK, persistence, conformance, and security suites
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
