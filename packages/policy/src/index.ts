/**
 * @uae/policy — the policy language (parser → AST → lowering), the structured
 * policy representation, validation, compilation, and versioning.
 * DRAFT shapes — see docs/architecture/api-boundaries.md and ADR-0012.
 */
export { allOf, anyOf, contextEquals, indirectRef, notExpr, relationRef } from "./expression.js";
export type {
  AllOf,
  AnyOf,
  ContextAttributeType,
  ContextEquals,
  ContextLiteral,
  IndirectRef,
  NotExpr,
  PolicyExpression,
  RelationRef,
} from "./expression.js";
export type {
  PolicyDefinition,
  RelationDeclaration,
  StructuredPolicy,
} from "./structured-policy.js";
export { validateStructuredPolicy } from "./validate.js";
export type { PolicyValidationResult } from "./validate.js";
export { canonicalJson, compileStructuredPolicy, isCompiledArtifactShape } from "./compile.js";
export type { CompiledPolicy, CompiledPolicyArtifact } from "./compile.js";
export { InMemoryPolicyStore, PolicyStoreError } from "./store.js";
// policy language (ADR-0012)
export { MAX_SOURCE_LENGTH, PolicySyntaxError, tokenize } from "./lexer.js";
export type { Token, TokenType } from "./lexer.js";
export { MAX_EXPRESSION_DEPTH, parsePolicy } from "./parser.js";
export { PolicyLoweringError, lowerPolicyAst } from "./lower.js";
export { PolicyValidationError } from "./validate.js";
export { compilePolicySource } from "./source.js";
export type { CompiledPolicySource } from "./source.js";
export type {
  ContextDeclAst,
  DefinitionAst,
  ExpressionAst,
  Location,
  PermissionAst,
  PolicyAst,
  RelationAst,
} from "./ast.js";
