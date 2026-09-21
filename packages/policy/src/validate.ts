import { ContextAttributeType } from "./expression.js";
import { validateExpression } from "./validate-expression.js";
import { RelationDeclaration } from "./structured-policy.js";

export interface PolicyValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const RELATION_RE = /^[a-z][a-z0-9_]*$/;
const PERMISSION_RE = /^[a-z][a-z0-9_]*$/;
const TYPE_RE = /^[a-z][a-z0-9_-]*$/;
const CONTEXT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const CONTEXT_TYPES: readonly ContextAttributeType[] = ["string", "number", "boolean"];

/**
 * Total structural validation at publish time (ADR-0009). Malformed policies
 * are rejected here and never loaded by the evaluator; a defective loaded
 * artifact still fails closed (ADR-0010 § error taxonomy).
 */
export function validateStructuredPolicy(source: unknown): PolicyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof source !== "object" || source === null) {
    return { valid: false, errors: ["policy source must be an object"], warnings };
  }
  const { definitions } = source as Record<string, unknown>;
  if (typeof definitions !== "object" || definitions === null) {
    return { valid: false, errors: ["policy source must define `definitions`"], warnings };
  }
  const defs = definitions as Record<string, unknown>;
  const defNames = Object.keys(defs);
  if (defNames.length === 0) {
    errors.push("policy must define at least one definition");
  }

  for (const typeName of defNames) {
    if (!TYPE_RE.test(typeName)) {
      errors.push(`definition type "${typeName}" is not a valid type name`);
    }
    const def = defs[typeName];
    if (typeof def !== "object" || def === null) {
      errors.push(`definition "${typeName}" must be an object`);
      continue;
    }
    const d = def as Record<string, unknown>;
    const relationNames = validateRelations(typeName, d["relations"], errors);
    const schemaKeys = validateContextSchema(typeName, d["contextSchema"], errors);
    validatePermissions(typeName, d["permissions"], relationNames, schemaKeys, errors, warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateRelations(
  typeName: string,
  relations: unknown,
  errors: string[],
): ReadonlySet<string> {
  const names = new Set<string>();
  if (typeof relations !== "object" || relations === null) {
    errors.push(`definition "${typeName}" must declare \`relations\` (may be empty)`);
    return names;
  }
  for (const [relName, decl] of Object.entries(relations as Record<string, unknown>)) {
    if (!RELATION_RE.test(relName)) {
      errors.push(`definition "${typeName}": invalid relation name "${relName}"`);
    }
    names.add(relName);
    const subjectTypes = (decl as RelationDeclaration | null)?.["subjectTypes"];
    if (!isStringArray(subjectTypes) || subjectTypes.length === 0) {
      errors.push(
        `definition "${typeName}", relation "${relName}": must declare non-empty subjectTypes`,
      );
    }
  }
  return names;
}

function validateContextSchema(
  typeName: string,
  contextSchema: unknown,
  errors: string[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (contextSchema === undefined) return keys;
  if (typeof contextSchema !== "object" || contextSchema === null) {
    errors.push(`definition "${typeName}": contextSchema must be an object`);
    return keys;
  }
  for (const [key, attrType] of Object.entries(contextSchema as Record<string, unknown>)) {
    if (!CONTEXT_KEY_RE.test(key)) {
      errors.push(`definition "${typeName}": invalid context key "${key}"`);
    }
    if (!CONTEXT_TYPES.includes(attrType as ContextAttributeType)) {
      errors.push(
        `definition "${typeName}", context key "${key}": attribute type must be string|number|boolean`,
      );
    }
    keys.add(key);
  }
  return keys;
}

function validatePermissions(
  typeName: string,
  permissions: unknown,
  relationNames: ReadonlySet<string>,
  schemaKeys: ReadonlySet<string>,
  errors: string[],
  warnings: string[],
): void {
  if (typeof permissions !== "object" || permissions === null) {
    errors.push(`definition "${typeName}" must declare \`permissions\` (may be empty)`);
    return;
  }
  for (const [permName, expr] of Object.entries(permissions as Record<string, unknown>)) {
    if (!PERMISSION_RE.test(permName)) {
      errors.push(`definition "${typeName}": invalid permission name "${permName}"`);
    }
    validateExpression(expr, {
      typeName,
      permName,
      relations: relationNames,
      schemaKeys,
      errors,
      warnings,
      notUnderAnd: true,
    });
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
