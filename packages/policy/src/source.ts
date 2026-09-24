/**
 * Source-level compile pipeline (ADR-0012):
 *
 *   policy text → tokenize → parse → lower → validate → compile (hash)
 *
 * This is the single entry point used by `InMemoryPolicyStore` for text source
 * and (from Phase 4) by the `authz validate` CLI. Each stage raises its own
 * typed error so callers can distinguish a syntax problem, a semantic problem,
 * and a structural validation problem.
 */
import { PolicyAst } from "./ast.js";
import { CompiledPolicy, compileStructuredPolicy } from "./compile.js";
import { lowerPolicyAst } from "./lower.js";
import { parsePolicy } from "./parser.js";
import { StructuredPolicy } from "./structured-policy.js";
import { PolicyValidationError, validateStructuredPolicy } from "./validate.js";

export interface CompiledPolicySource extends CompiledPolicy {
  /** Parsed AST — retained so tooling can report on source structure. */
  readonly ast: PolicyAst;
  /** Lowered structured policy (the compiler's input). */
  readonly policy: StructuredPolicy;
  /** Non-fatal findings from validation (never silently discarded). */
  readonly warnings: readonly string[];
}

/** Compile policy *text* into a validated, hashed artifact. */
export function compilePolicySource(source: string): CompiledPolicySource {
  const ast = parsePolicy(source);
  const policy = lowerPolicyAst(ast);
  const validation = validateStructuredPolicy(policy);
  if (!validation.valid) {
    throw new PolicyValidationError(validation.errors, validation.warnings);
  }
  const { artifact, hash } = compileStructuredPolicy(policy);
  return { ast, policy, artifact, hash, warnings: validation.warnings };
}
