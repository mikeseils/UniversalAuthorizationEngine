/**
 * @uae/policy — structured policy representation, validation, compilation,
 * and versioning (Phase 2; the text syntax arrives in Phase 3).
 * DRAFT shapes — see docs/architecture/api-boundaries.md.
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
