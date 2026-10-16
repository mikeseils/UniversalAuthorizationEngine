# Control Plane / Data Plane

Status: **Implemented in part** (ADR-0007). The Phase 8 data plane is a
deployable HTTP service that consumes signed policy artifacts; the control
plane is the CLI/SDK compile-and-sign pipeline (no hosted control-plane
service; multi-region replication remains deferred).

## Control plane

Responsibilities:

- policy management (authoring, validation, tests, review workflow)
- policy versioning, staged deployment (staging → v19, production → v18)
- configuration, organizations, tenancy, API credentials
- dashboards, analytics, compliance exports
- publishing **immutable, signed policy artifacts** to data planes

Latency-insensitive. Trust boundary: the data plane should not blindly trust
the control plane at runtime — signed policy artifacts (`policy → sign →
immutable artifact → data plane verifies signature`) keep a compromised
dashboard from silently escalating production access.

## Data plane

The decision path:

```
authorization request → decision
```

Requirements:

- horizontally scalable, low latency
- independently deployable, geographically deployable
- can function **without constant control-plane access** (holds current policy
  artifact; a node always knows exactly which policy version it evaluates —
  never "sort of current" policy state)

## Relationship to the core

The evaluator core is identical in both planes' context: the control plane
_produces_ compiled policy versions; data-plane nodes _consume_ them through
the `PolicyStore` interface. In Phase 0–2 both are trivially the same
in-process store; the interface is what keeps the future split cheap.

## Multi-region sketch (deferred)

```
                 Global Control Plane
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
       US-East        EU-West        AP-South
      AuthZ nodes    AuthZ nodes    AuthZ nodes
```

Policies replicate globally as immutable versions; relationship replication
follows each customer's consistency requirements (roadmap: consistency model,
Phase 12/42).
