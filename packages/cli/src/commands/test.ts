import { EXIT, ValidationFailure, type ExitCode } from "../errors.js";
import { hasFlag, type ParsedCommand } from "../args.js";
import type { CliIo } from "../io.js";
import { type Console, renderExplanation } from "../output.js";
import { makeConsole } from "../render.js";
import {
  discoverTestFiles,
  loadConfigIfPresent,
  resolvePolicyPath,
  resolveRelationshipsPath,
} from "../resolve.js";
import { loadSession, readTextFile } from "../session.js";
import { parseTestFile } from "../test-language/parser.js";
import { AssertionResult, runTestBlock } from "../test-language/runner.js";

/**
 * `authz test [file|dir ...]` (ADR-0013/0014).
 *
 * Test files are discovered deterministically (sorted), parsed, and executed in
 * file then source order. A failing assertion prints the decision *and* the
 * engine's explanation, so the terminal answers "why" without a debugger.
 * Malformed test files are reported as validation failures while other files
 * still run — one bad file must not hide the rest of the suite.
 */
export async function runTest(command: ParsedCommand, io: CliIo): Promise<ExitCode> {
  const con = makeConsole(io, hasFlag(command, "--no-color"));
  const json = hasFlag(command, "--json");
  const config = loadConfigIfPresent(io);
  const policyFile = resolvePolicyPath(io, command, config, undefined);
  const relationshipsFile = resolveRelationshipsPath(io, command, config);
  const files = discoverTestFiles(io, command, config);

  const session = await loadSession({ policyFile, relationshipsFile });
  for (const warning of session.warnings) con.error(`warning: ${warning}`);

  const results: AssertionResult[] = [];
  const fileErrors: string[] = [];
  const testsPerFile: { file: string; tests: number }[] = [];

  for (const file of files) {
    const source = readTextFile(file, "test file");
    let blocks;
    try {
      blocks = parseTestFile(source);
    } catch (error) {
      fileErrors.push(`${file}: ${message(error)}`);
      continue;
    }
    testsPerFile.push({ file, tests: blocks.length });
    for (const block of blocks) {
      const blockResults = await runTestBlock(block, {
        policyStore: session.policyStore,
        baseline: session.baseline,
        file,
      });
      results.push(...blockResults);
    }
  }

  const failures = results.filter((result) => !result.passed);
  const ok = failures.length === 0 && fileErrors.length === 0;

  if (json) {
    con.json({
      ok,
      policy: { file: policyFile, version: session.policyVersion },
      relationships: relationshipsFile,
      files: testsPerFile.length,
      tests: testsPerFile.reduce((total, entry) => total + entry.tests, 0),
      assertions: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
      failures: failures.map((failure) => ({
        file: failure.file,
        line: failure.line,
        test: failure.testName,
        assertion: failure.source,
        expected: failure.target,
        actual: {
          allowed: failure.decision.allowed,
          reason: failure.decision.reason ?? null,
          policyVersion: failure.decision.policyVersion ?? null,
        },
      })),
      errors: fileErrors,
    });
  } else {
    for (const entry of testsPerFile) {
      con.line(`${entry.file} — ${String(entry.tests)} test(s)`);
    }
    for (const failure of failures) {
      con.line("");
      con.line(
        con.paint(
          `FAIL ${relative(failure.file, io.cwd)}:${String(failure.line)} ${failure.testName}`,
          "red",
          "bold",
        ),
      );
      con.line(`  assertion: ${failure.source}`);
      con.line(
        `  expected: ${failure.target}  actual: ${failure.decision.allowed ? "allow" : (failure.decision.reason ?? "deny")}`,
      );
      const explanation = failure.decision.explanation;
      if (explanation !== undefined) {
        for (const line of renderTestExplanation(explanation, con)) con.line(line);
      }
    }
    for (const error of fileErrors) con.error(`error: ${error}`);
    con.line("");
    con.line(
      `${String(results.length - failures.length)}/${String(results.length)} assertion(s) passed` +
        (fileErrors.length > 0 ? `, ${String(fileErrors.length)} file error(s)` : ""),
    );
  }

  return ok ? EXIT.ok : EXIT.validation;
}

function renderTestExplanation(
  explanation: NonNullable<AssertionResult["decision"]["explanation"]>,
  con: Console,
): readonly string[] {
  const lines = ["  explanation:"];
  for (const line of renderExplanation(explanation, con, 2)) lines.push(line);
  return lines;
}

function relative(file: string, cwd: string): string {
  return file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;
}

function message(error: unknown): string {
  if (error instanceof ValidationFailure) return error.message;
  return error instanceof Error ? error.message : String(error);
}
