import { EXIT, CliError, type ExitCode } from "../errors.js";
import { hasFlag, flagValue, type ParsedCommand } from "../args.js";
import type { CliIo } from "../io.js";
import { makeConsole } from "../render.js";
import { createPgQueryable, PostgresPolicyStore, runMigrations } from "@uae/persistence";
import {
  ENVIRONMENT_ENV,
  GOVERNANCE_ACTOR_ENV,
  requireConnectionString,
  resolveStoreBackend,
} from "../store.js";

/** `authz policy-activate <version>` (Phase 9 governance).
 *
 * Explicitly activates a previously published policy version and records the
 * act in the governance audit trail. Activation is a deliberate deployment act
 * (ADR-0018 S7): it never happens as a side effect of publishing. Requires a
 * Postgres backend.
 */
export async function runPolicyActivate(command: ParsedCommand, io: CliIo): Promise<ExitCode> {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const version = command.positionals[0];
  if (version === undefined) {
    throw new CliError("authz policy-activate requires <version>", EXIT.usage);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new CliError(`invalid policy version "${version}"`, EXIT.validation);
  }
  const backend = resolveStoreBackend(flagValue(command, "--store"), io.env);
  if (backend !== "postgres") {
    throw new CliError("authz policy-activate requires --store postgres", EXIT.usage);
  }
  const connectionString = requireConnectionString(io.env);
  const environment = flagValue(command, "--environment") ?? io.env[ENVIRONMENT_ENV] ?? "default";
  const actor = flagValue(command, "--actor") ?? io.env[GOVERNANCE_ACTOR_ENV] ?? "operator";
  const json = hasFlag(command, "--json");

  const db = createPgQueryable({ connectionString });
  try {
    await runMigrations(db);
    const policyStore = new PostgresPolicyStore(db, { environment });
    await policyStore.setActiveVersion(version);
    await db.query(
      `INSERT INTO policy_governance (environment, version, action, actor) VALUES ($1, $2, $3, $4)`,
      [environment, version, "activate", actor],
    );
    if (json) {
      con.json({ action: "activate", environment, version, actor });
    } else {
      con.line(`activated policy version ${version} (environment ${environment}, actor ${actor})`);
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `failed to activate policy: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.infrastructure,
    );
  } finally {
    await db.end();
  }
}
