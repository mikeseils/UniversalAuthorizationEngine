/**
 * CLI failure taxonomy (ADR-0013). One error class with an explicit exit code,
 * so the mapping from failure kind to process status is impossible to get
 * subtly wrong at the call site.
 */

/** Exit codes — the CLI's contract with shells and CI (ADR-0013). */
export const EXIT = {
  /** Success. */
  ok: 0,
  /** Content validation failed (policy, relationship data, or a test). */
  validation: 1,
  /** Usage error (bad flags, unreadable input, malformed context/config). */
  usage: 2,
  /** The decision was DENY — a successful evaluation, not a failure. */
  denied: 3,
  /** Infrastructure error (typed engine failure). */
  infrastructure: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Base class for every failure the CLI reports itself. */
export class CliError extends Error {
  public readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** Returned when help was requested — help is not an error (ADR-0013). */
export class HelpRequested extends Error {
  public readonly text: string;

  constructor(text: string) {
    super(text);
    this.name = "HelpRequested";
    this.text = text;
  }
}

/** Whether a `CliError` carries this exit code (avoids instanceof chains). */
export function hasExitCode(error: CliError, code: ExitCode): boolean {
  return error.exitCode === code;
}

/** Bad invocation, or input the CLI cannot read: exit 2. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.usage);
    this.name = "UsageError";
  }
}

/** Input read successfully but failed validation: exit 1. */
export class ValidationFailure extends CliError {
  constructor(message: string) {
    super(message, EXIT.validation);
    this.name = "ValidationFailure";
  }
}

/** Infrastructure failure from the engine: exit 4. */
export class InfrastructureFailure extends CliError {
  constructor(message: string) {
    super(message, EXIT.infrastructure);
    this.name = "InfrastructureFailure";
  }
}
