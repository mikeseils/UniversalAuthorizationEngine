# ADR-0013: `authz` CLI — commands, formats, and failure contract

- Status: Accepted
- Date: 2026-09-24
- Context: Phase 4 (implements the CLI reserved by ADR-0005; consumes the
  Phase 3 policy language and the Phase 2 evaluator)

## Decision

Ship a dependency-free CLI (`packages/cli`, binary `authz`) with four commands,
each backed by functionality that already exists:

| Command                                     | Backed by                                      |
| ------------------------------------------- | ---------------------------------------------- |
| `authz init [dir]`                          | scaffolding only (no engine calls)             |
| `authz validate [file]`                     | `compilePolicySource`, relationship validation |
| `authz test [files\|dirs…]`                 | test-language runner + evaluator               |
| `authz check <subject> <action> <resource>` | evaluator `check()` + explanations             |

Commands are only added when the functionality behind them is real. `authz
deploy`, `authz explain <decisionId>`, `authz dev`, and `listAuthorized` are
**not** implemented — the first two need a decision store / policy-version
pinning that does not exist yet.

## Argument parsing

No CLI framework dependency (no commander/yargs). The surface is four commands
with a handful of flags each; a dependency would add supply-chain surface and
non-deterministic help/error formatting to a security tool for little benefit.
Parsing is hand-written and spec-driven in `args.ts`; unknown flags, missing
values, and unexpected positionals are usage errors. Tradeoff accepted: help
text is maintained by hand.

## Exit-code contract

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Success                                                              |
| 1    | Validation failure or failing test                                   |
| 2    | Usage error (bad flags, unreadable/missing input, malformed context) |
| 3    | The evaluated decision was **deny** (`check`)                        |
| 4    | Infrastructure error (typed engine error)                            |

Rationale — **a DENY is a successful evaluation, not a CLI failure.** It gets
its own code so a shell can distinguish "the engine said no" (3) from "the
engine could not answer" (4) from "you called me wrong" (2). `authz check`
therefore enables deny-is-failure by default, with `--no-fail-on-deny` to opt
out; `--json` still prints the full decision in both cases.

Deny exit status is configurable rather than fixed because both usages are
legitimate: `authz check … && deploy` wants failure semantics, while a
diagnostic session wants 0. Inside `authz test`, assertions decide pass/fail —
the deny code is never used.

## Output contract

- Human-readable by default; `--json` prints one stable, documented JSON object
  on **stdout** for every command. Machine consumers use `--json`.
- Warnings and errors go to **stderr**, never mixed into `--json` stdout.
- No ANSI color when stdout is not a TTY, when `NO_COLOR` is set, or with
  `--no-color`.
- Output order is deterministic (file order, then source order).

## Formats (versioned from day one)

Per `../architecture/api-boundaries.md`, persisted/consumed file formats do not
get "draft" freedom.

**`authz.json` (config)** — discovered in the working directory or its nearest
ancestor; explicit flags always win.

```json
{
  "formatVersion": 1,
  "policy": "policy.authz",
  "relationships": "relationships.jsonl",
  "tests": ["tests"]
}
```

- `formatVersion` is **required** and must be `1`.
- Unknown top-level keys are **rejected** (a typo like `"policies"` must not
  silently change behavior).
- Relative paths resolve against the **config file's directory**, not the
  process cwd, so results do not depend on where the command was invoked.
- `tests` entries are files or directories; directories are scanned recursively
  for `*.test.authz`. There are **no glob patterns in v1** (no half-specified
  matching semantics to get wrong).

**`relationships.jsonl` (relationship data)** — JSON Lines:

```
// comments and blank lines are allowed
{"formatVersion":1}
{"subject":"user:alice","relation":"admin","resource":"organization:acme"}
```

- The optional first non-comment line may declare `{"formatVersion": 1}`;
  absence means version 1. Any other version is rejected.
- Every relationship line must have exactly `subject`, `relation`, `resource`.
  **Unknown or missing keys are errors** (line-numbered) — silently ignoring a
  typo in a security-relevant data file is how access is granted by accident.
- Values are validated with the core identifier/relationship parsers.
- The compact `subject|relation|resource` form used by tests stays a **test
  fixture helper only**: an unescaped delimiter format must not become a
  user-facing contract.

## Path and overwrite safety (`init`)

- `init` writes only inside the target directory (default: cwd).
- It computes the full file set and refuses if **any** target exists, unless
  `--force` is given — no partial scaffolds, no silent overwrites.
- Read-only commands (`validate`, `test`, `check`) never write files.

## Consequences

- `packages/cli` depends on `core`, `policy`, and `evaluator` (allowed by the
  layering rule); nothing depends on it.
- All command logic is reachable through `run(argv, io)` with injected
  `cwd`/`stdout`/`stderr`/`env`, so tests exercise real code paths without
  spawning processes. One smoke test spawns the built binary to prove the
  Windows bin shim and shebang wiring.
- Policy-version pinning (`--policy-version`) is deferred: `Evaluator` reads the
  active version only, and multi-version retrieval is a storage concern that
  belongs with the persistent store (Phase 6).
- `--json` shapes are documented in `../development/cli.md` and covered by
  tests, since CI consumers depend on them.
