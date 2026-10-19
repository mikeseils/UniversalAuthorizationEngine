import { EXIT, CliError, type ExitCode } from "../errors.js";
import { hasFlag, flagValue, type ParsedCommand } from "../args.js";
import type { CliIo } from "../io.js";
import { makeConsole } from "../render.js";
import { createPgQueryable, runMigrations } from "@uae/persistence";
import {
  ENVIRONMENT_ENV,
  GOVERNANCE_ACTOR_ENV,
  requireConnectionString,
  resolveStoreBackend,
} from "../store.js";

/** `authz compliance export` (Phase 9 compliance exports).
 *
 * Emits machine-readable evidence as NDJSON: the active policy version per
 * environment plus the governance audit trail (publish / activate / provision
 * acts). Read-only SELECT queries only — the export never mutates state and
 * never includes headers, API keys, or request bodies (log-safety rule).
 * Requires a Postgres backend.
 */
export async function runComplianceExport(command: ParsedCommand, io: CliIo): Promise<ExitCode> {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const backend = resolveStoreBackend(flagValue(command, "--store"), io.env);
  if (backend !== "postgres") {
    throw new CliError("authz compliance export requires --store postgres", EXIT.usage);
  }
  const connectionString = requireConnectionString(io.env);
  const environment = flagValue(command, "--environment") ?? io.env[ENVIRONMENT_ENV] ?? "default";
  const actor = flagValue(command, "--actor") ?? io.env[GOVERNANCE_ACTOR_ENV] ?? "operator";
  const since = flagValue(command, "--since");
  const json = hasFlag(command, "--json");

  const db = createPgQueryable({ connectionString });
  try {
    await runMigrations(db);

    // Active policy version for this environment (fail-closed: absent => null).
    const active = await db.query<{ readonly version: string | null }>(
      `SELECT version FROM policy_deployments WHERE environment = $1`,
      [environment],
    );
    const activeVersion = active.rows[0]?.version ?? null;

    // Governance audit trail, append-only by convention.
    let sql = `SELECT id, version, action, actor, created_at FROM policy_governance WHERE environment = $1 ORDER BY created_at DESC, id DESC`;
    const values: unknown[] = [environment];
    if (since !== undefined) {
      sql = `SELECT id, version, action, actor, created_at FROM policy_governance WHERE environment = $1 AND created_at >= $2 ORDER BY created_at DESC, id DESC`;
      values.push(since);
    }
    const events = await db.query<{
      readonly id: number;
      readonly version: string;
      readonly action: string;
      readonly actor: string;
      readonly created_at: Date;
    }>(sql, values);

    const exportDoc = {
      exportedAt: new Date().toISOString(),
      environment,
      actor,
      activePolicyVersion: activeVersion,
      since,
      events: events.rows.map((row) => ({
        id: row.id,
        version: row.version,
        action: row.action,
        actor: row.actor,
        createdAt: row.created_at.toISOString(),
      })),
    };

    if (json) {
      con.json(exportDoc);
    } else {
      con.line(`compliance export for environment "${environment}"`);
      con.line(`  exported at: ${exportDoc.exportedAt}`);
      con.line(`  active policy version: ${activeVersion ?? "(none)"}`);
      con.line(`  governance events: ${String(events.rows.length)}`);
      for (const row of events.rows) {
        con.line(
          `  ${String(row.id).padEnd(4)} ${row.action.padEnd(9)} ${row.version}  ${row.actor}  ${row.created_at}`,
        );
      }
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `failed to export compliance evidence: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.infrastructure,
    );
  } finally {
    await db.end();
  }
}
