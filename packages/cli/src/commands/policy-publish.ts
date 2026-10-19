import { EXIT, CliError, type ExitCode } from "../errors.js";
import { hasFlag, flagValue, type ParsedCommand } from "../args.js";
import type { CliIo } from "../io.js";
import { makeConsole } from "../render.js";
import { loadConfigIfPresent, resolvePolicyPath } from "../resolve.js";
import { compilePolicyFile } from "../session.js";
import { createPgQueryable, PostgresPolicyStore, runMigrations } from "@uae/persistence";
import {
  ENVIRONMENT_ENV,
  GOVERNANCE_ACTOR_ENV,
  requireConnectionString,
  resolveStoreBackend,
} from "../store.js";

/** `authz policy-publish <policyFile>` (Phase 9 governance).
 *
 * Compiles the policy, publishes it as a new immutable version, activates it,
 * and records the act in the governance audit trail. Requires a Postgres
 * backend (`--store postgres` or $AUTHZ_STORE=postgres plus $AUTHZ_DATABASE_URL).
 * Publishing and activation are separate acts (ADR-0018 S7); here they are
 * bundled for convenience, with the act recorded either way.
 */
export async function runPolicyPublish(command: ParsedCommand, io: CliIo): Promise<ExitCode> {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const config = loadConfigIfPresent(io);
  const policyFile = resolvePolicyPath(io, command, config, command.positionals[0]);
  const backend = resolveStoreBackend(flagValue(command, "--store"), io.env);
  if (backend !== "postgres") {
    throw new CliError(
      `authz policy-publish requires --store postgres, got ${backend}`,
      EXIT.usage,
    );
  }
  const connectionString = requireConnectionString(io.env);
  const environment = flagValue(command, "--environment") ?? io.env[ENVIRONMENT_ENV] ?? "default";
  const actor = flagValue(command, "--actor") ?? io.env[GOVERNANCE_ACTOR_ENV] ?? "operator";
  const json = hasFlag(command, "--json");

  const db = createPgQueryable({ connectionString });
  try {
    await runMigrations(db);
    const policyStore = new PostgresPolicyStore(db, { environment });
    const compiled = compilePolicyFile(policyFile);
    const published = await policyStore.publishPolicy({ source: compiled.policy });
    await policyStore.setActiveVersion(published.version);
    await db.query(
      `INSERT INTO policy_governance (environment, version, action, actor) VALUES ($1, $2, $3, $4)`,
      [environment, published.version, "publish", actor],
    );
    if (json) {
      con.json({ action: "publish", environment, version: published.version, actor });
    } else {
      con.line(
        `published policy version ${published.version} (environment ${environment}, actor ${actor})`,
      );
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `failed to publish policy: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.infrastructure,
    );
  } finally {
    await db.end();
  }
}
