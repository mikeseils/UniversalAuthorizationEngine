# Domain Model

Status: **Implemented** (as typed interfaces in `packages/core`) — the
_concepts_ are the contract; wire formats are non-final until the SDK ships.

## Overview

| Concept      | Description                                                              | Example                                             |
| ------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| Subject      | Entity requesting an operation                                           | `user:alice`, `service:billing`, `agent:support-42` |
| Action       | Operation being requested                                                | `read`, `document.delete`, `refund`                 |
| Resource     | Entity being accessed                                                    | `document:456`, `project:123`, `organization:acme`  |
| Context      | Additional request information                                           | `{ mfa: true, ip: "…", time: "…" }`                 |
| Relationship | Typed edge between entities                                              | `user:alice → member → organization:acme`           |
| Policy       | Declaration of which relationship/context combinations grant permissions | (Phase 3)                                           |
| Decision     | The answer, plus why                                                     | `{ allowed, explanation?, policyVersion? }`         |

## Subject

An entity performing the request. Subjects are opaque identifiers of the form
`type:id` (see [Identifiers](#identifiers)). Typical types:

- `user:alice` — human principal
- `service:billing` — machine principal (service-to-service)
- `agent:support-42` — AI agent (a **first-class subject**, not a separate
  authorization model; delegation expressed as a relationship such as
  `agent:support-42 → acts_on_behalf_of → user:alice`)
- `device:…`, `external_user:…` — deferred (roadmap Phases 21, 25)

The engine knows as little about subjects as possible (**PII minimization**,
`docs/security/security-principles.md`): prefer `user:12345` over an email
address. It does not need names, emails, or phones to decide.

## Resource

An entity being accessed, also `type:id`. Resources may nest through
relationships (`project:123 → contains → document:456`) enabling permission
inheritance.

## Action

The operation. **Open decision — documented alternatives, deliberate choice
deferred to the policy-language ADR (ADR-0008 follow-up):**

| Option                | Example                              | Pros                                                       | Cons                                       |
| --------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------ |
| Flat strings          | `read`, `write`                      | Simple, familiar                                           | Namespace collisions across resource types |
| Dotted type-scoped    | `document.read`, `project.write`     | Self-describing; maps to resource type; hierarchical later | Slightly more verbose                      |
| Verb + resource pairs | `{ verb: "read", type: "document" }` | Structured, no string parsing                              | Heavier API                                |

Current direction: dotted, type-scoped action strings with possible future
hierarchy (`document.read` ⊂ `document.all`), stored as plain strings for now.
Do not build hierarchy inference yet.

## Context

Additional request information supplied per check:

```json
{
  "mfa": true,
  "ip": "203.0.113.9",
  "deviceTrust": "managed",
  "time": "2026-09-21T12:00:00Z",
  "requestId": "…"
}
```

Constraints (binding):

- Context is **data, not code**. It must never become an uncontrolled channel
  for embedding arbitrary business logic into the evaluator (no expression
  strings, no callbacks).
- Context is untrusted input: validated against a policy's declared context
  schema before use; unknown keys are ignored by evaluation but retained for
  audit.
- A missing/unavailable context attribute makes conditions depending on it
  **not satisfied** (default-deny, ADR-0006).

## Relationship

A first-class record:

```json
{ "subject": "user:alice", "relation": "member", "resource": "organization:acme" }
```

- `relation` is a name defined by the policy schema (e.g. `member`, `editor`,
  `owner`, `contains`, `acts_on_behalf_of`).
- Relationships are the **single inheritance mechanism**: Alice edits project
  Alpha; project Alpha contains Document A; therefore Alice can read Document A.
- The engine doesn't care where relationships come from (app DB, LDAP, Okta,
  events); identity management stays external.
- Relationships are tenant-scoped; cross-tenant edges are invalid unless a
  policy explicitly allows sharing (tested invariant, `docs/security/threat-model.md`).

## Policy

A declaration of which relationship/context combinations grant permissions.
Versioned, immutable once published; evaluation cites an exact version
(ADR-0007). Phase 0–2 uses structured in-memory policy; a language is chosen in
Phase 3.

## Identifiers

Identifiers are `type:id` strings, validated at the boundary:

- `type`: `[a-z][a-z0-9_-]*` (lowercase kebab, starts with a letter)
- `id`: one or more characters, no whitespace, no `:` (reserved separator)
- Parser rejects: missing separators, empty parts, uppercase types, whitespace,
  empty strings, non-string input → these become type-safe objects or a
  validation error, never silently accepted.

## Canonical example domain

Used throughout docs and tests (`examples/`):

```
Acme
├── Alice  (admin → Acme, owner → Project Alpha)
├── Bob    (member → Acme, viewer → Project Alpha)
└── Project Alpha
     ├── Document A
     └── Document B
```

Relationships:

```
user:alice --admin--> organization:acme
user:bob   --member--> organization:acme
organization:acme --owns--> project:alpha
user:alice --owner--> project:alpha
user:bob   --viewer--> project:alpha
project:alpha --contains--> document:a
project:alpha --contains--> document:b
```

This exercises RBAC (org roles), ReBAC (graph inheritance), allow, deny,
explanations, and tenant isolation.
