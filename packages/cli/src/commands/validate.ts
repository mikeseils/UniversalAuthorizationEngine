import { CompiledPolicySource } from "@uae/policy";
import { EXIT, CliError, hasExitCode, type ExitCode } from "../errors.js";
import { hasFlag, type ParsedCommand } from "../args.js";
import type { CliIo } from "../io.js";
import { makeConsole } from "../render.js";
import { readRelationshipsFile, type RelationshipsLoadResult } from "../relationships-file.js";
import { loadConfigIfPresent, resolvePolicyPath, resolveRelationshipsPath } from "../resolve.js";
import { compilePolicyFile } from "../session.js";

/**
 * `authz validate [policyFile]` (ADR-0013).
 *
 * Reports every diagnostic it can instead of stopping at the first, and keeps
 * warnings (e.g. negation-based grants) separate from errors: warnings never
 * change the exit code unless `--strict` is given. Positions come from the
 * policy language's own error types — the CLI formats them, it does not
 * compute them.
 */
export function runValidate(command: ParsedCommand, io: CliIo): ExitCode {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const config = loadConfigIfPresent(io);
  const policyFile = resolvePolicyPath(io, command, config, command.positionals[0]);
  const relationshipsFile = resolveRelationshipsPath(io, command, config);
  const strict = hasFlag(command, "--strict");
  const json = hasFlag(command, "--json");

  let compiled: CompiledPolicySource | null = null;
  let policyError: string | null = null;
  try {
    compiled = compilePolicyFile(policyFile);
  } catch (error) {
    if (error instanceof CliError && hasExitCode(error, EXIT.validation)) {
      policyError = error.message;
    } else {
      throw error;
    }
  }

  let relationships: RelationshipsLoadResult | null = null;
  if (relationshipsFile !== null) {
    relationships = readRelationshipsFile(relationshipsFile);
  }

  const warnings = compiled?.warnings ?? [];
  const failures: string[] = [];
  if (policyError !== null) failures.push(policyError);
  for (const error of relationships?.errors ?? []) failures.push(error);

  const strictFailure = strict && warnings.length > 0;
  const ok = failures.length === 0 && !strictFailure;

  if (json) {
    con.json({
      ok,
      strict,
      policy: {
        file: policyFile,
        valid: policyError === null,
        error: policyError,
        definitions: compiled === null ? null : Object.keys(compiled.policy.definitions).length,
        hash: compiled?.hash ?? null,
      },
      relationships:
        relationships === null || relationshipsFile === null
          ? null
          : {
              file: relationshipsFile,
              valid: relationships.errors.length === 0,
              count: relationships.relationships.length,
              errors: relationships.errors,
            },
      warnings,
    });
  } else {
    con.line(
      compiled === null
        ? con.paint(`policy: INVALID (${policyFile})`, "red", "bold")
        : con.paint(`policy: ok (${policyFile})`, "green", "bold"),
    );
    if (compiled !== null) {
      con.line(`  definitions: ${String(Object.keys(compiled.policy.definitions).length)}`);
      con.line(`  hash: ${compiled.hash}`);
    }
    if (relationshipsFile !== null && relationships !== null) {
      const valid = relationships.errors.length === 0;
      con.line(
        valid
          ? con.paint(`relationships: ok (${relationshipsFile})`, "green", "bold")
          : con.paint(`relationships: INVALID (${relationshipsFile})`, "red", "bold"),
      );
      con.line(`  tuples: ${String(relationships.relationships.length)}`);
    }
    for (const warning of warnings) con.error(`warning: ${warning}`);
    for (const failure of failures) con.error(`error: ${failure}`);
    if (strictFailure) {
      con.error(`error: ${String(warnings.length)} warning(s) treated as errors by --strict`);
    }
  }

  return ok ? EXIT.ok : EXIT.validation;
}
