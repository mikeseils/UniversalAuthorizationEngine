/**
 * @uae/cli — the `authz` CLI (ADR-0013) and the policy test language
 * (ADR-0014). The binary is `dist/main.js`; `run()` is the testable entry point.
 */
export { run } from "./run.js";
export {
  EXIT,
  CliError,
  HelpRequested,
  InfrastructureFailure,
  UsageError,
  ValidationFailure,
} from "./errors.js";
export type { ExitCode } from "./errors.js";
export { COMMANDS, commandUsage, parseArgs, usageText } from "./args.js";
export type { CommandSpec, FlagSpec, ParsedCommand, ParseResult } from "./args.js";
export { createCapturingIo, createProcessIo } from "./io.js";
export type { CapturedIo, CliIo } from "./io.js";
export { CONFIG_FILENAME, CONFIG_FORMAT_VERSION, findConfigFile, loadConfig } from "./config.js";
export type { CliConfig } from "./config.js";
export { parseRelationshipsJsonl, readRelationshipsFile } from "./relationships-file.js";
export type { RelationshipsLoadResult } from "./relationships-file.js";
export { discoverTestFiles, loadConfigIfPresent } from "./resolve.js";
export { parseTestFile } from "./test-language/parser.js";
export type { TestAssertion, TestBlock, TestTarget, TestTuple } from "./test-language/parser.js";
export { assertionHolds, runTestBlock } from "./test-language/runner.js";
export type { AssertionResult } from "./test-language/runner.js";
export { parseContext } from "./commands/check.js";
