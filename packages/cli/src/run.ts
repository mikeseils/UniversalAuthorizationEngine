import { ValidationError } from "@uae/core";
import { PolicyLoweringError, PolicySyntaxError, PolicyValidationError } from "@uae/policy";
import { parseArgs } from "./args.js";
import { runCheck } from "./commands/check.js";
import { runInit } from "./commands/init.js";
import { runPolicyActivate } from "./commands/policy-activate.js";
import { runPolicyAudit } from "./commands/policy-audit.js";
import { runPolicyPublish } from "./commands/policy-publish.js";
import { runTest } from "./commands/test.js";
import { runValidate } from "./commands/validate.js";
import { EXIT, CliError, HelpRequested, type ExitCode } from "./errors.js";
import type { CliIo } from "./io.js";

/**
 * CLI entry point (ADR-0013): parse, dispatch, map failures to documented exit
 * codes. Everything is injected through {@link CliIo}, so tests exercise this
 * exact path without spawning a process.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.kind === "help") {
      io.stdout(parsed.text);
      return EXIT.ok;
    }
    const { command } = parsed;
    switch (command.spec.name) {
      case "init":
        return runInit(command, io);
      case "validate":
        return runValidate(command, io);
      case "test":
        return await runTest(command, io);
      case "check":
        return await runCheck(command, io);
      case "policy-activate":
        return await runPolicyActivate(command, io);
      case "policy-audit":
        return await runPolicyAudit(command, io);
      case "policy-publish":
        return await runPolicyPublish(command, io);
      default:
        return report(new CliError(`unhandled command "${command.spec.name}"`, EXIT.usage), io);
    }
  } catch (error) {
    return report(error, io);
  }
}

/**
 * Failure mapping (ADR-0013). The order matters: explicit CLI failures keep
 * their own code, authoring errors are validation failures (1), malformed
 * request input is a usage error (2), and anything else is infrastructure (4)
 * — never a DENY, and never a silent success.
 */
function report(error: unknown, io: CliIo): ExitCode {
  if (error instanceof HelpRequested) {
    io.stdout(error.text);
    return EXIT.ok;
  }
  if (error instanceof CliError) {
    io.stderr(`error: ${error.message}`);
    return error.exitCode;
  }
  if (
    error instanceof PolicySyntaxError ||
    error instanceof PolicyLoweringError ||
    error instanceof PolicyValidationError
  ) {
    io.stderr(`error: ${error.message}`);
    return EXIT.validation;
  }
  if (error instanceof ValidationError) {
    io.stderr(`error: ${error.message}`);
    return EXIT.usage;
  }
  io.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
  return EXIT.infrastructure;
}
