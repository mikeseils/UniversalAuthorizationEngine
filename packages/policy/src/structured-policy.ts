import { ContextAttributeType, PolicyExpression } from "./expression.js";

/** A relation accepted on a definition, with the subject types it allows. */
export interface RelationDeclaration {
  readonly subjectTypes: readonly string[];
}

/**
 * One resource-type definition (docs/adr/0009-structured-policy.md).
 * DRAFT representation — replaced at source level by the Phase 3 language.
 */
export interface PolicyDefinition {
  readonly relations: Readonly<Record<string, RelationDeclaration>>;
  readonly permissions: Readonly<Record<string, PolicyExpression>>;
  /** Declared context keys; conditions may only reference declared keys. */
  readonly contextSchema?: Readonly<Record<string, ContextAttributeType>>;
}

export interface StructuredPolicy {
  readonly definitions: Readonly<Record<string, PolicyDefinition>>;
}
