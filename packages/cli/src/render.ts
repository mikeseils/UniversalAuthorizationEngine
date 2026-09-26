import type { AuthorizationDecision } from "@uae/core";
import type { CliIo } from "./io.js";
import { type Console, colorEnabled, createConsole, renderExplanation } from "./output.js";

/** Shared rendering for a single decision (used by `check` and test failures). */
export function renderDecisionLines(
  decision: AuthorizationDecision,
  con: Console,
  label: string,
): readonly string[] {
  const verdict = decision.allowed
    ? con.paint("ALLOW", "green", "bold")
    : con.paint("DENY", "red", "bold");
  const lines = [
    `${label}${con.paint(":", "dim")} ${verdict}`,
    `  reason: ${decision.reason ?? "(none)"}${decision.policyVersion === undefined ? "" : `  policyVersion: ${decision.policyVersion}`}`,
  ];
  if (decision.explanation !== undefined) {
    lines.push("  explanation:");
    lines.push(...renderExplanation(decision.explanation, con, 2));
  }
  return lines;
}

export function decisionJson(decision: AuthorizationDecision): Record<string, unknown> {
  return {
    allowed: decision.allowed,
    reason: decision.reason ?? null,
    policyVersion: decision.policyVersion ?? null,
    explanation: decision.explanation ?? null,
  };
}

export function makeConsole(io: CliIo, noColor: boolean): Console {
  return createConsole(io, colorEnabled(io, noColor));
}
