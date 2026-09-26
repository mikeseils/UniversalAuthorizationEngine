import type { ExplanationNode } from "@uae/core";
import type { CliIo } from "./io.js";

/**
 * Output helpers (ADR-0013): deterministic human text, `--json` on stdout,
 * diagnostics on stderr, and color only on a TTY with `NO_COLOR` unset.
 */

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
} as const;

export type ColorName = keyof typeof ANSI;

export interface Console {
  /** Whether color is enabled for this invocation. */
  readonly color: boolean;
  line(text?: string): void;
  error(text: string): void;
  json(value: unknown): void;
  paint(text: string, ...colors: ColorName[]): string;
}

/** Whether ANSI color may be used (TTY, not disabled by env or flag). */
export function colorEnabled(io: CliIo, noColorFlag: boolean): boolean {
  if (noColorFlag) return false;
  if (io.env["NO_COLOR"] !== undefined) return false;
  return io.isTty;
}

export function createConsole(io: CliIo, color: boolean): Console {
  const paint = (text: string, ...colors: ColorName[]): string => {
    if (!color || colors.length === 0) return text;
    const codes = colors.map((name) => ANSI[name]).join("");
    return `${codes}${text}${ANSI.reset}`;
  };
  return {
    color,
    line: (text = "") => {
      io.stdout(text);
    },
    error: (text) => {
      io.stderr(text);
    },
    json: (value) => {
      io.stdout(JSON.stringify(value, null, 2));
    },
    paint,
  };
}

const GLYPH: Record<ExplanationNode["outcome"], string> = {
  matched: "yes",
  not_matched: "no",
  unknown: "unknown",
  skipped: "skipped",
};

const OUTCOME_COLOR: Record<ExplanationNode["outcome"], ColorName> = {
  matched: "green",
  not_matched: "dim",
  unknown: "yellow",
  skipped: "dim",
};

/**
 * Render an explanation tree (ADR-0011). Always from the same evaluation pass
 * that produced the decision — the CLI never recomputes it.
 */
export function renderExplanation(
  node: ExplanationNode,
  con: Console,
  indent = 0,
): readonly string[] {
  const prefix = "  ".repeat(indent);
  const glyph = con.paint(`[${GLYPH[node.outcome]}]`, OUTCOME_COLOR[node.outcome]);
  const lines = [`${prefix}${glyph} ${node.kind}: ${node.description}`];
  for (const child of node.children ?? []) {
    lines.push(...renderExplanation(child, con, indent + 1));
  }
  return lines;
}
