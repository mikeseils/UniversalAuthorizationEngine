import type { AuthorizationContext, ExplanationLevel } from "@uae/core";
import { flagValue, hasFlag, type ParsedCommand } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../errors.js";
import type { CliIo } from "../io.js";
import { decisionJson, makeConsole, renderDecisionLines } from "../render.js";
import { loadConfigIfPresent, resolvePolicyPath, resolveRelationshipsPath } from "../resolve.js";
import { loadSession } from "../session.js";
import { requireConnectionString, resolveStoreBackend } from "../store.js";

const LEVELS: readonly ExplanationLevel[] = ["none", "minimal", "standard", "debug"];

/**
 * `authz check <subject> <action> <resource>` (ADR-0013).
 *
 * Deny-is-failure is on by default so `authz check … && deploy` is safe; the
 * deny exit code (3) is distinct from infrastructure failure (4). Human output
 * shows an explanation by default — that is the point of the tool — while
 * `--json` stays minimal unless `--explain` is given.
 */
export async function runCheck(command: ParsedCommand, io: CliIo): Promise<ExitCode> {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const config = loadConfigIfPresent(io);
  const policyFile = resolvePolicyPath(io, command, config, undefined);
  const relationshipsFile = resolveRelationshipsPath(io, command, config);

  const subject = command.positionals[0] as string;
  const action = command.positionals[1] as string;
  const resource = command.positionals[2] as string;
  const context = parseContext(flagValue(command, "--context"));
  const level = parseLevel(flagValue(command, "--explain"), hasFlag(command, "--json"));
  // Pinning is opt-in (ADR-0019); omitted means "use the active version".
  const pinned = flagValue(command, "--policy-version");

  // Backend selection is opt-in and explicit (Phase 6): flag, then
  // $AUTHZ_STORE, then in-memory. Never inferred.
  const backend = resolveStoreBackend(flagValue(command, "--store"), io.env);
  const postgres =
    backend === "postgres" ? { connectionString: requireConnectionString(io.env) } : undefined;

  const session = await loadSession({
    policyFile,
    relationshipsFile,
    ...(postgres === undefined ? {} : { postgres }),
  });
  try {
    for (const warning of session.warnings) {
      con.error(`warning: ${warning}`);
    }
    const decision = await session.evaluator.check(
      {
        subject,
        action,
        resource,
        ...(context === undefined ? {} : { context }),
      },
      {
        explanation: level,
        ...(pinned === undefined ? {} : { policyVersion: pinned }),
      },
    );

    if (hasFlag(command, "--json")) {
      con.json({ ok: decision.allowed, decision: decisionJson(decision) });
    } else {
      for (const line of renderDecisionLines(decision, con, `${subject} ${action} ${resource}`)) {
        con.line(line);
      }
    }

    if (decision.allowed) return EXIT.ok;
    return hasFlag(command, "--no-fail-on-deny") ? EXIT.ok : EXIT.denied;
  } finally {
    // Always release the pool: an unclosed pool keeps the process alive after
    // the decision has already been printed, which looks like a hung CLI.
    await session.close();
  }
}

/**
 * `--context` must be a JSON object of primitive values. Nested objects and
 * nulls are rejected rather than silently ignored: context is untrusted input
 * and dead values in a security decision are worse than an error.
 */
export function parseContext(raw: string | undefined): AuthorizationContext | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(
      `--context is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("--context must be a JSON object, e.g. '{\"mfa\":true}'");
  }
  const context: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      context[key] = value;
      continue;
    }
    throw new UsageError(
      `--context key "${key}" must be a string, number, or boolean (got ${value === null ? "null" : typeof value})`,
    );
  }
  return context;
}

function parseLevel(raw: string | undefined, json: boolean): ExplanationLevel {
  if (raw === undefined) return json ? "none" : "standard";
  const level = LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    throw new UsageError(`--explain must be one of ${LEVELS.join(", ")} (got "${raw}")`);
  }
  return level;
}
