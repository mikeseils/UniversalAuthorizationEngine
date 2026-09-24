/**
 * Policy AST (ADR-0012) — the boundary between the source language and the
 * compiled `StructuredPolicy` representation. DRAFT shape.
 *
 * Every node carries a source `location` so diagnostics (syntax, lowering,
 * validation, later static analysis) can point at the offending construct.
 * The AST is deliberately semantics-free: all semantic rules are enforced by
 * lowering (see `lower.ts`).
 */

/** One-based source position of the first character of a construct. */
export interface Location {
  readonly line: number;
  readonly column: number;
}

export interface RelationAst {
  readonly name: string;
  readonly subjectTypes: readonly string[];
  /** Present for incoming edges: `target --via--> resource`. */
  readonly via?: string;
  readonly location: Location;
}

export interface ContextDeclAst {
  readonly key: string;
  readonly type: "string" | "number" | "boolean";
  readonly location: Location;
}

export type ExpressionAst =
  | { readonly kind: "relationRef"; readonly name: string; readonly location: Location }
  | {
      readonly kind: "permissionOn";
      readonly targetType: string;
      readonly permission: string;
      readonly location: Location;
    }
  | {
      readonly kind: "contextEquals";
      readonly key: string;
      readonly value: string | number | boolean;
      readonly location: Location;
    }
  | {
      readonly kind: "and";
      readonly operands: readonly ExpressionAst[];
      readonly location: Location;
    }
  | {
      readonly kind: "or";
      readonly operands: readonly ExpressionAst[];
      readonly location: Location;
    };

export interface PermissionAst {
  readonly name: string;
  readonly expression: ExpressionAst;
  readonly location: Location;
}

export interface DefinitionAst {
  readonly name: string;
  readonly relations: readonly RelationAst[];
  readonly context: readonly ContextDeclAst[];
  readonly permissions: readonly PermissionAst[];
  readonly location: Location;
}

export interface PolicyAst {
  readonly definitions: readonly DefinitionAst[];
}
