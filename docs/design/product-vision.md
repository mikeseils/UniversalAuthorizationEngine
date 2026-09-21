# Product Vision

> Status legend used across all docs: **Implemented** / **Planned** / **Experimental** / **Deferred**

## What this is

The Universal Authorization Engine is a developer-friendly authorization
system: a reusable infrastructure primitive for SaaS applications, APIs,
microservices, internal systems, and eventually AI agents.

It answers one fundamental question:

> **Can SUBJECT perform ACTION on RESOURCE under the current POLICY and CONTEXT?**

```
Subject + Action + Resource + Context + Relationships + Policy
        ↓
Authorization Decision + Explanation
```

## What this is not

This project is **not an authentication provider**. It does not replace Auth0,
Okta, identity providers, password systems, or user directories. It consumes
identity information and decides what that identity may do. Identity management
stays external (see the enterprise integration principles in the roadmap).

## The product promise

> **Define** who can do what, **test** it like code, **deploy** it like
> infrastructure, and **explain** every decision.

Four pillars — everything else supports them.

## Positioning

Not "another authorization platform," but **authorization infrastructure for
developers**. The opportunity studied in ADR-0008 is not that authorization
doesn't exist — it's that the existing abstractions (Zanzibar, OpenFGA,
SpiceDB, Cedar, OPA, Oso, Cerbos) are still too complicated for the median
application developer.

The deeper architectural value: today authorization logic scatters across
frontend, API, service, queue, and database layers, each with slightly
different rules and no single authoritative answer. This engine aims to be the
**canonical decision point** — one policy, evaluated identically at every layer.

## Conceptual API (target, not yet implemented)

```ts
const decision = await authz.check({
  subject: "user:alice",
  action: "document.delete",
  resource: "document:123",
});

// Now:  { allowed: true }
// Eventually: { allowed: true, policyVersion: "42", explanation: { ... } }
```

The `check()` API stays intentionally simple; `checkBatch()` follows; `explain()`
and `listAuthorized()` come later and only when the model supports them
correctly.

## Long-term north star

Make authorization a **universal, portable, inspectable software primitive** —
the way developers assume HTTP, SQL, JSON, TLS, and queues exist everywhere:

```
authorize(subject, action, resource, context)  // available everywhere
```

across web apps, APIs, microservices, databases, CLI tools, background jobs,
cloud infrastructure, AI agents, and human workflows — with the same
underlying model (human, service, agent, and device principals all in one
system).

## The three technical properties that matter (Phase 61 of the vision)

Before any platform features, we must prove:

1. **Correctness** — given policy + relationships + context, decisions are
   deterministic and safe (default-deny, ADR-0006).
2. **Speed** — high check volumes without authorization becoming a bottleneck.
3. **Explainability** — every decision can be understood after the fact.

If those aren't excellent, everything built on top is irrelevant.

## Current status

- Implemented: repository foundation, documentation, domain-model types
  (`packages/core`), initial tests.
- Planned: evaluator, policy language, CLI, SDK, persistence, caching,
  hosted/self-hosted infrastructure (see `docs/development/roadmap.md`).
