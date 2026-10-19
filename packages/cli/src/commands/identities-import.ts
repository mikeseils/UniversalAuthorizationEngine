import { coerceIdentifier } from "@uae/core";
import { EXIT, CliError, type ExitCode } from "../errors.js";
import { hasFlag, flagValue, type ParsedCommand } from "../args.js";
import type { CliIo } from "../io.js";
import { makeConsole } from "../render.js";
import { createPgQueryable, PostgresRelationshipWriter, runMigrations } from "@uae/persistence";
import {
  ENVIRONMENT_ENV,
  GOVERNANCE_ACTOR_ENV,
  requireConnectionString,
  resolveStoreBackend,
} from "../store.js";

/** `authz identities import <mappingFile>` (Phase 9 SCIM provisioning mapping).
 *
 * Reads a SCIM-style identity mapping (externalId -> opaque subject ID) and
 * provisions it into the relationship store as idempotent `mappedTo` edges
 * from `scim:<externalId>` to the target subject. The engine stores **no user
 * directory, no PII, no passwords** — only opaque subject IDs. The mapping is
 * external identity -> subject ID; policies and relationships evaluate the
 * subject ID, never the external identity.
 *
 * Requires a Postgres backend (`--store postgres` plus $AUTHZ_DATABASE_URL).
 * Import is idempotent: re-importing the same file changes no state and bumps
 * nothing, so retried imports after a network failure are safe.
 */
export async function runIdentitiesImport(command: ParsedCommand, io: CliIo): Promise<ExitCode> {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const mappingFile = command.positionals[0];
  if (mappingFile === undefined) {
    throw new CliError("authz identities import requires <mappingFile>", EXIT.usage);
  }
  const backend = resolveStoreBackend(flagValue(command, "--store"), io.env);
  if (backend !== "postgres") {
    throw new CliError("authz identities import requires --store postgres", EXIT.usage);
  }
  const connectionString = requireConnectionString(io.env);
  const environment = flagValue(command, "--environment") ?? io.env[ENVIRONMENT_ENV] ?? "default";
  const actor = flagValue(command, "--actor") ?? io.env[GOVERNANCE_ACTOR_ENV] ?? "operator";
  const json = hasFlag(command, "--json");

  const fs = await import("node:fs");
  let text: string;
  try {
    text = fs.readFileSync(mappingFile, "utf8");
  } catch (error) {
    throw new CliError(`cannot read mapping file ${mappingFile}`, EXIT.usage);
  }

  const mappings: { readonly externalId: string; readonly subject: string }[] = [];
  let lineNumber = 0;
  for (const rawLine of text.split(/\r?\n/u)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new CliError(`${mappingFile}:${String(lineNumber)}: not valid JSON`, EXIT.validation);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CliError(
        `${mappingFile}:${String(lineNumber)}: expected a JSON object`,
        EXIT.validation,
      );
    }
    const raw = parsed as Record<string, unknown>;
    const externalId = raw["externalId"];
    const subject = raw["subject"];
    if (typeof externalId !== "string" || externalId.length === 0) {
      throw new CliError(
        `${mappingFile}:${String(lineNumber)}: externalId must be a non-empty string`,
        EXIT.validation,
      );
    }
    if (typeof subject !== "string") {
      throw new CliError(
        `${mappingFile}:${String(lineNumber)}: subject must be a type:id string`,
        EXIT.validation,
      );
    }
    // Validate the subject is a well-formed opaque identifier before storing.
    try {
      coerceIdentifier(subject, `subject`);
    } catch {
      throw new CliError(
        `${mappingFile}:${String(lineNumber)}: subject "${subject}" is not a valid type:id identifier`,
        EXIT.validation,
      );
    }
    mappings.push({ externalId, subject });
  }

  const db = createPgQueryable({ connectionString });
  try {
    await runMigrations(db);
    const relationships = mappings.map((m) => ({
      subject: { type: "scim", id: m.externalId },
      relation: "mappedTo",
      resource: { type: m.subject.split(":")[0], id: m.subject.split(":")[1] },
    }));
    const writer = new PostgresRelationshipWriter(db);
    const inserted = await writer.addBatch(relationships);
    // Record the provisioning act in the governance audit trail.
    await db.query(
      `INSERT INTO policy_governance (environment, version, action, actor) VALUES ($1, $2, $3, $4)`,
      [environment, "scim-import", "provision", actor],
    );
    if (json) {
      con.json({
        action: "identities.import",
        environment,
        imported: mappings.length,
        inserted,
        actor,
      });
    } else {
      con.line(
        `imported ${String(mappings.length)} SCIM identity mapping(s) (environment ${environment}, actor ${actor}), ${String(inserted)} new edge(s)`,
      );
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `failed to import identities: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.infrastructure,
    );
  } finally {
    await db.end();
  }
}
