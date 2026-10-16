# Universal Authorization Engine

[![CI](https://github.com/mikeseils/UniversalAuthorizationEngine/actions/workflows/ci.yml/badge.svg)](https://github.com/mikeseils/UniversalAuthorizationEngine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

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

## SDK (`@uae/sdk`)

The SDK is the supported client surface — applications should not wire up
stores and the evaluator themselves.

```ts
// A denial and an engine outage are different things, and stay different things.
const allowed = await authz.isAllowed({ subject, action, resource });
// ^ throws AuthorizationUnavailableError on infrastructure failure.
// ^ pass { onUnavailable: "deny" } to fail closed to `false` instead.
// ^ there is no option that fails open.

const outcomes = await authz.checkBatch([req1, req2, req3]);
// 1:1 with the input; one unavailable item never invalidates its siblings.
```

Three ways to construct a client (design: ADR-0015, ADR-0016):

| Constructor                                       | Use when                                       |
| ------------------------------------------------- | ---------------------------------------------- |
| `AuthzClient.inMemory({ policy, relationships })` | Prototyping and tests — nothing else to run    |
| `AuthzClient.fromEvaluator(evaluator)`            | The engine is already embedded in your process |
| `AuthzClient.fromTransport(baseUrl)`              | A deployed data plane answers over HTTP        |

Transports are pluggable (`ClientTransport`), so the same client code works
in-process or against a remote data plane. An in-process check can also
return an **explanation** of how the decision was reached — pass
`{ explanation: "minimal" | "standard" | "debug" }`; disclosure levels are
deliberate (see `docs/design/explanations.md`).

## CLI (`authz`)

For policy authors working locally (ADR-0013, ADR-0014):

| Command          | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `authz init`     | Scaffold a starter policy and policy tests  |
| `authz validate` | Syntax + schema verification of a policy    |
| `authz test`     | Run declarative assertions against a policy |
| `authz check`    | One-off evaluation from the terminal        |

See `examples/acme/` for the canonical policy, its relationships, and its
tests, and `docs/design/policy-language.md` for the language itself.

## Run the service (data plane)

The data plane is an independently deployable HTTP node: it loads a compiled
(Ed25519-signed) policy artifact, reads relationships from PostgreSQL, and
answers checks with API-key authentication, structured logs, and Prometheus
metrics — without contacting a control plane at runtime (ADR-0007, ADR-0024).

```sh
git clone https://github.com/mikeseils/UniversalAuthorizationEngine.git
cd UniversalAuthorizationEngine
docker compose up --build           # data plane + PostgreSQL (health-gated)
curl http://localhost:3000/healthz  # → {"status":"ok"}
```

| Endpoint           | Auth    | Purpose                               |
| ------------------ | ------- | ------------------------------------- |
| `POST /check`      | API key | Single authorization check            |
| `POST /checkBatch` | API key | Batch of checks with per-item results |
| `GET /version`     | API key | Active policy version (503 when none) |
| `GET /healthz`     | —       | Liveness probe                        |
| `GET /metrics`     | —       | Prometheus metrics                    |

Checks fail closed with **503** until you configure a policy artifact, and
always: missing/invalid key → **401**, malformed JSON → **400**, oversized
body → **413**, rate exceeded → **429**, unreachable store → **503**.

Configuration is environment-only (`UAE_API_KEYS`, `UAE_ARTIFACT_PATH`,
`UAE_PG_URL`, limits, signature enforcement) — see `.env.example` and
`docs/operations/deployment.md` for the full reference plus edge
responsibilities (TLS, key rotation, metrics scraping). CI publishes the
container image on every push to `main`, and
`docs/operations/disaster-recovery.md` covers backup, restore, and key
compromise.

## Documentation

| Where                                  | What                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `docs/design/`                         | Product vision, domain/authorization/evaluation model, policy language, explanations |
| `docs/architecture/`                   | Overview, control/data plane, storage, caching, failure modes, scaling               |
| `docs/adr/`                            | Architecture decision records — the reasoning behind every major choice              |
| `docs/operations/deployment.md`        | Running the data plane: configuration, edge responsibilities                         |
| `docs/operations/disaster-recovery.md` | Backup, restore, key compromise, fail-closed recovery                                |
| `docs/security/`                       | Threat model and security principles                                                 |
| `docs/development/roadmap.md`          | Phase-by-phase implementation status and what comes next                             |
| `SECURITY.md`                          | Supported status and vulnerability reporting                                         |

## Security considerations

- **Default deny**: unknown or errored evaluation is always DENY — never a
  silent allow. Denial is distinct from infrastructure failure.
- Tenant isolation, bounded traversal, and explicit failure modes are core
  properties, tested adversarially.
- See `docs/security/threat-model.md` and `docs/security/security-principles.md`.
  To report a vulnerability, see `SECURITY.md`.

## Development setup

Requires Node.js 22.13+ or 24+ and pnpm (Docker not required). In PowerShell:

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
├── .github/workflows/     CI (install → typecheck → lint → format → test → build → docker → publish)
├── docs/
│   ├── adr/               Architecture decision records
│   ├── architecture/      Overview, control/data plane, storage, caching, failure modes
│   ├── design/            Vision, domain model, authorization model, evaluation, explanations
│   ├── development/       Roadmap, local development, testing strategy
│   ├── operations/        Deployment and disaster recovery runbooks
│   └── security/          Threat model, security principles
├── packages/
│   ├── core/              Domain types + store interfaces (zero dependencies)
│   ├── policy/            Policy language (lexer/parser/AST/lowering), validation, versioned store
│   ├── evaluator/         Deterministic evaluator + explanations
│   ├── sdk/               TypeScript SDK: stable client API, decision/unavailable outcomes
│   ├── cli/               authz CLI: init, validate, test, check
│   ├── persistence/       PostgreSQL relationship + policy stores, SQL migrations
│   └── data-plane/        Data-plane HTTP service: artifact loader, server, entrypoint
├── examples/acme/         Canonical example domain (policy, relationships, tests)
├── scripts/bench.mjs      Access-pattern benchmark (pnpm bench)
└── tests/                 Engine, CLI, SDK, persistence, conformance, and security suites
```

## Contributing

Read `CONTRIBUTING.md`. In short: documentation and ADRs precede substantial
implementation; `main` stays buildable and green; descriptive commits;
default-deny is non-negotiable.

## License

[MIT](./LICENSE)
