import { EXIT, CliError, type ExitCode } from "../errors.js";
import { hasFlag, flagValue, type ParsedCommand } from "../args.js";
import type { CliIo } from "../io.js";
import { makeConsole } from "../render.js";
import { createPgQueryable, runMigrations } from "@uae/persistence";
import { ENVIRONMENT_ENV, requireConnectionString, resolveStoreBackend } from "../store.js";

/** `authz policy-audit` (Phase 9 governance).
 *
 * Lists the governance audit trail for an environment: who published, approved,
 * or activated which policy version and when. Append-only by convention —
 * historical rows are never updated or deleted. Requires a Postgres backend.
 */
export async function runPolicyAudit(command: ParsedCommand, io: CliIo): Promise<ExitCode> {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const backend = resolveStoreBackend(flagValue(command, "--store"), io.env);
  if (backend !== "postgres") {
    throw new CliError("authz policy-audit requires --store postgres", EXIT.usage);
  }
  const connectionString = requireConnectionString(io.env);
  const environment = flagValue(command, "--environment") ?? io.env[ENVIRONMENT_ENV] ?? "default";
  const json = hasFlag(command, "--json");

  const db = createPgQueryable({ connectionString });
  try {
    await runMigrations(db);
    const result = await db.query<{
      readonly id: number;
      readonly version: string;
      readonly action: string;
      readonly actor: string;
      readonly created_at: Date;
    }>(
      `SELECT id, version, action, actor, created_at FROM policy_governance WHERE environment = $1 ORDER BY created_at DESC, id DESC`,
      [environment],
    );
    if (json) {
      con.json({ environment, events: result.rows });
    } else {
      con.line(`governance audit for environment "${environment}":`);
      if (result.rows.length === 0) {
        con.line("  (no governance events recorded)");
      }
      for (const row of result.rows) {
        con.line(
          `  ${String(row.id).padEnd(4)} ${row.action.padEnd(9)} ${row.version}  ${row.actor}  ${row.created_at}`,
        );
      }
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `failed to read governance audit: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.infrastructure,
    );
  } finally {
    await db.end();
  }
}
