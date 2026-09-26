/**
 * Injected process surface (ADR-0013). Every command writes only through this
 * interface, so tests drive the real code paths with captured output instead of
 * spawning processes.
 */
export interface CliIo {
  /** Working directory (config discovery starts here). */
  readonly cwd: string;
  /** Write a line to stdout (machine-readable channel with `--json`). */
  readonly stdout: (line: string) => void;
  /** Write a line to stderr (diagnostics; never mixed into `--json`). */
  readonly stderr: (line: string) => void;
  /** Environment (color policy: `NO_COLOR`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdout is a terminal (color is only used on a TTY). */
  readonly isTty: boolean;
}

/** Real process wiring, used only by `main.ts`. */
export function createProcessIo(): CliIo {
  return {
    cwd: process.cwd(),
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    env: process.env,
    isTty: process.stdout.isTTY,
  };
}

/** In-memory io for tests and embedding. */
export interface CapturedIo extends CliIo {
  readonly output: readonly string[];
  readonly errors: readonly string[];
}

/** Create a {@link CliIo} that captures stdout/stderr into arrays. */
export function createCapturingIo(options?: {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  isTty?: boolean;
}): CapturedIo {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    cwd: options?.cwd ?? process.cwd(),
    stdout: (line) => {
      output.push(line);
    },
    stderr: (line) => {
      errors.push(line);
    },
    env: options?.env ?? {},
    isTty: options?.isTty ?? false,
    output,
    errors,
  };
}
