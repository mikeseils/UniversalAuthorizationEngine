# ADR-0020: Storage error taxonomy and the classification contract

Status: **Accepted** (Phase 6)
Related: ADR-0006 (default deny), ADR-0010 (fail-closed semantics),
ADR-0016 (SDK outcome taxonomy), ADR-0017 (database decision),
ADR-0018 (store semantics contract, S4),
`docs/architecture/failure-modes.md`.

## Context

ADR-0018 S4 requires that a storage failure is _typed and distinguishable_ and
is never signalled as an empty result. The reason it is worth an ADR is that
"typed" is the easy half. The hard half is deciding **which** types exist,
because a caller facing a store failure has to make a real operational decision:

- do I retry, and if so with what backoff?
- do I page someone, or is this expected backpressure?
- is my schema even deployed?

Answering those from a raw `pg` error means reading `err.code` strings and
`err.message` text at the call site. Message matching is exactly the kind of
coupling that rots: PostgreSQL rewords messages between major versions, and a
substring test that silently stops matching does not fail loudly — it quietly
reclassifies an outage as a query bug.

Phase 6 also produced a concrete defect while hardening the pool. node-postgres
raises `ECONNRESET` on an **idle** client the server dropped. Nobody is awaiting
that error, so with no `error` listener it becomes an unhandled `'error'` event
and takes the host process down. The fix was a mandatory pool error listener,
but the listener only _handed the error somewhere_ — the classification of what
it received was still undefined, so "handed somewhere" had become "swallowed
with a warning."

## Decision

### D1 — Three classes, and the reasons they are separate

```ts
class PersistenceError extends Error {          // base: an infrastructure failure
  readonly reason:
    | "unavailable"                              // connectivity
    | "timeout"                                  // deadline exceeded
    | "query_failed"                             // the statement itself was wrong
    | "schema_missing";                          // not migrated
}
class StoreUnavailableError extends PersistenceError  // reason: "unavailable"
class StoreTimeoutError     extends PersistenceError  // reason: "timeout"
```

Subclassing rather than unioning is deliberate. `instanceof` is the mechanism a
caller reaches for, and it is checked at compile time; a bare string reason is
checked at runtime by a human reading a log. The subclasses carry the reason so
that logging and metrics keep the cheap discriminator, while control flow uses
the type.

`timeout` is separated from `unavailable` because they demand _different_
responses. A timeout is a capacity or latency problem — raise the bound, add the
missing index, scale the pool. Unavailability is a connectivity problem — restart
the server, fix the network, fail over. Both fail closed, so the security posture
is identical; only the operator response differs, and conflating them turns a
tuning signal into a paging incident.

### D2 — The mapping is normative

`persistenceError(operation, error)` is the single classification point. Every

### D3 — Classification happens once, and is idempotent

`persistenceError` returns an already-typed `PersistenceError` unchanged. A
`StoreUnavailableError` raised by the pool listener and then seen by a caller
wrapping their own query is the _same object_, not a re-wrapped one. This is
what makes it safe to classify at both the listener and the call site: double
classification is a no-op rather than a chance to lose the original cause.

### D4 — The cause is preserved; the reason never carries secrets

The driver error is always attached as `cause`, so no diagnostic detail is lost.
The typed error's own fields carry only the operation name and the reason — never
a connection string. A connection string in an error message is a credential leak
into logs and error reporters, and it is the kind of leak that survives long
after the incident that produced it.

### D5 — Every reason is fail-closed, and none of them is a DENY

All four reasons throw. None is ever converted to an empty result set, and none
is an `allowed: false`. This restates S4 at the type level: a missing table, a
timeout, and a constraint violation are three different operational states, and
none of them is "this subject has no permissions."

### D6 — The boundary upward is the SDK, and it is structural

`AuthorizationUnavailableError` (ADR-0016) is the type that reaches application
code. `persistenceError` exists below that boundary so that a Postgres failure
and a policy-store failure stay distinguishable _inside_ the engine, while both
surface to the application as the same structural `unavailable` outcome. The SDK
does not import `@uae/persistence`, and `@uae/persistence` does not import the
SDK — the core stays dependency-free (ADR-0005), and the storage taxonomy is
reachable by name only from the package that owns it.

## Consequences

- A caller can write `catch (e) { if (e instanceof StoreTimeoutError) … }`
  without parsing anything, and the compiler rejects a typo in the class name.
- Metrics keyed on `reason` remain a flat, low-cardinality string, so the
  subclassing costs nothing operationally.
- Adding a driver failure mode is a table row plus a test, not a hunt through
  call sites.
- The taxonomy is only as good as its table, so the table is asserted row by row
  in `tests/persistence-sql.test.ts` and re-verified against a live database
  through the conformance suite. A driver upgrade that changes a code or a
  message surfaces as a failed classification test rather than as a
  misclassified outage in production.
- `StoreUnavailableError` covers the idle-client drop that motivated this ADR,
  which is what stops the mandatory pool listener from being a way to lose errors
  quietly.

## Alternatives considered

- **Let driver errors propagate unwrapped.** Rejected: it pushes `err.code`
  string matching onto every caller and makes the timeout-vs-unavailable
  distinction a per-caller guess.
- **A single `StoreError` with a reason field, no subclasses.** Rejected: it is
  strictly worse ergonomics for the same information. Control flow would be
  `reason === "timeout"`, an untyped runtime comparison, in place of
  `instanceof StoreTimeoutError` checked by the compiler. The reason field is
  still present; it is just not the _only_ way to discriminate.
- **Merge `timeout` into `unavailable`.** Rejected: identical security posture,
  different operator response. Collapsing them reports a slow query as a database
  outage and discards the diagnostic that would have found the missing index.
- **Classify by message only.** Rejected: PostgreSQL rewords messages between
  major versions, and a message test that stops matching fails silently —
  reclassifying an outage as a query bug, which is precisely the failure mode
  ADR-0018 S4 exists to prevent.

store method routes its driver failures through it, and the mapping is part of
the contract rather than an implementation detail:

| Driver signal                                                                                                                                                                           | `reason`         | Class                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------- |
| `42P01`, `42703`                                                                                                                                                                        | `schema_missing` | `PersistenceError`      |
| `57014` (server `statement_timeout`), `ETIMEDOUT`, message matching `/timeout/i`                                                                                                        | `timeout`        | `StoreTimeoutError`     |
| `ECONNREFUSED`, `ECONNRESET`, `EPIPE`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `57P01`, SQLSTATE `08xxx`, or message containing `connection` followed by `terminated`, `closed`, `ended`, or `refused` | `unavailable` | `StoreUnavailableError` |
| everything else                                                                                                                                                                         | `query_failed`   | `PersistenceError`      |

Three properties of this table are load-bearing:

- **Order is part of the contract.** `57014` is checked before the connectivity
  codes. A server-side statement timeout and a dropped socket produce the same
  "the database did not answer" symptom to a user, and only the code separates
  them. Checking schema first keeps a genuinely unmigrated database from being
  reported as a connection problem when the missing table is the cause.
- **`query_failed` is the default, and that is a security choice.** A constraint
  violation, bad SQL, or corrupt row is a bug in the caller. It is not dressed as
  unavailability because retrying it will fail identically, and a retry loop over
  a `query_failed` is how a correctness bug becomes a denial-of-service.
- **Matching is on `code` first, message only as a fallback.** Message patterns
  exist for the driver paths that ship no code at all; they are the last resort,
  not the primary signal.
