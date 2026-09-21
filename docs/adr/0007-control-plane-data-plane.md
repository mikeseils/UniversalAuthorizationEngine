# ADR-0007: Control plane / data plane separation

- Status: Accepted
- Date: 2026-09-21
- Context: Architectural direction; no distributed infrastructure is implemented yet.

## Context

The long-term product supports hosted, self-hosted, and embedded deployment
(`docs/architecture/overview.md`). The core architecture must not make any of
these impossible.

## Decision

Separate responsibilities now, in design only:

**Control plane** — policy management, policy versions, configuration,
organizations, API credentials, dashboards, analytics, deployment. Latency-
insensitive; eventually a web service and UI.

**Data plane** — `check()` / `checkBatch()`: request → decision. Latency-
sensitive, horizontally scalable, independently deployable, and eventually able
to operate without constant control-plane access (cached/replicated policy
artifacts).

## Core design constraints flowing from this decision

- Policies are **immutable, versioned artifacts**. Evaluation always references
  an exact policy version; decisions can record `policyVersion` for
  reproducibility and rollback.
- The evaluator consumes published policy through an interface (`PolicyStore`);
  it never reads mutable policy state mid-evaluation.
- Relationship data is also supplied through an interface (`RelationshipStore`),
  so persistent backends, caches, and change streams can be introduced later
  without changing evaluation semantics.
- The core must remain embeddable (in-process) so the "embedded engine"
  deployment model stays available.

## Consequences

- No distributed infrastructure is built in Phase 0. This ADR constrains
  interfaces, not implementation.
