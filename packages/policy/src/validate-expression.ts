export interface ExpressionValidationContext {
  readonly typeName: string;
  readonly permName: string;
  /** Declared relations for the definition, when known. */
  readonly relations: ReadonlySet<string>;
  /** Declared context keys for the definition. */
  readonly schemaKeys: ReadonlySet<string>;
  readonly errors: string[];
  readonly warnings: string[];
  /** True when a `not` at this position contributes directly to a grant. */
  readonly notUnderAnd: boolean;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Structural validation of one expression node. The input is untrusted
 * (`unknown`): every field is checked defensively before use.
 */
export function validateExpression(raw: unknown, ctx: ExpressionValidationContext): void {
  const where = `definition "${ctx.typeName}", permission "${ctx.permName}"`;
  if (typeof raw !== "object" || raw === null) {
    ctx.errors.push(`${where}: expression must be an object`);
    return;
  }
  const expr = raw as Record<string, unknown>;
  switch (expr["kind"]) {
    case "relation": {
      const relation = expr["relation"];
      if (typeof relation !== "string" || !NAME_RE.test(relation)) {
        ctx.errors.push(`${where}: invalid relation reference ${JSON.stringify(relation)}`);
      } else if (!ctx.relations.has(relation)) {
        ctx.errors.push(`${where}: references undeclared relation "${relation}"`);
      }
      break;
    }
    case "indirect": {
      const relation = expr["relation"];
      const permission = expr["permission"];
      if (typeof relation !== "string" || !NAME_RE.test(relation)) {
        ctx.errors.push(
          `${where}: indirect traversal has invalid relation ${JSON.stringify(relation)}`,
        );
      }
      if (typeof permission !== "string" || !NAME_RE.test(permission)) {
        ctx.errors.push(
          `${where}: indirect traversal has invalid permission ${JSON.stringify(permission)}`,
        );
      }
      if (typeof expr["reverse"] !== "boolean") {
        ctx.errors.push(`${where}: indirect traversal \`reverse\` must be boolean`);
      }
      break;
    }
    case "contextEquals": {
      const key = expr["key"];
      const value = expr["value"];
      if (typeof key !== "string" || !ctx.schemaKeys.has(key)) {
        ctx.errors.push(
          `${where}: contextEquals references undeclared context key ${JSON.stringify(key)}`,
        );
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        ctx.errors.push(`${where}: contextEquals value must be a string|number|boolean literal`);
      }
      break;
    }
    case "and":
    case "or": {
      const operands = expr["operands"];
      if (!Array.isArray(operands) || operands.length < 1) {
        ctx.errors.push(`${where}: "${expr["kind"]}" requires at least one operand`);
        break;
      }
      const inner = { ...ctx, notUnderAnd: false };
      for (const op of operands as unknown[]) {
        validateExpression(op, inner);
      }
      break;
    }
    case "not": {
      if (ctx.notUnderAnd) {
        ctx.warnings.push(
          `${where}: "not" contributes directly to a grant; negation-based grants are dangerous (missing data yields unknown → deny). Prefer an "and" guard.`,
        );
      }
      validateExpression(expr["operand"], { ...ctx, notUnderAnd: true });
      break;
    }
    default: {
      ctx.errors.push(`${where}: unknown or missing expression kind`);
    }
  }
}
