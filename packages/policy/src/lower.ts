/**
 * Lowering (ADR-0012): `PolicyAst` → `StructuredPolicy`.
 *
 * The AST is semantics-free, so every semantic rule lives here:
 *
 * - referenced relations must be declared in the same definition;
 * - `targetType.permission` must name a declared definition and a permission
 *   that definition declares;
 * - traversal direction is derived from the relation declarations —
 *   `relation x: T` is an outgoing edge, `relation x: T via e` is an incoming
 *   edge named `e` on the target side — and **ambiguity is an error** rather
 *   than a guess about the author's intent;
 * - context conditions may only reference declared keys, with a matching
 *   literal type;
 * - duplicate definitions, relations, permissions, and context keys are
 *   rejected, as are relation/permission name collisions.
 *
 * Lowering fails fast on the first diagnostic, with a precise source location.
 * Exhaustive multi-error reporting is a static-analysis concern (later phase).
 */
import { DefinitionAst, ExpressionAst, Location, PolicyAst } from "./ast.js";
import {
  ContextAttributeType,
  PolicyExpression,
  allOf,
  anyOf,
  contextEquals,
  indirectRef,
  relationRef,
} from "./expression.js";
import { PolicyDefinition, RelationDeclaration, StructuredPolicy } from "./structured-policy.js";

/** Raised for source that parses but does not describe a coherent policy. */
export class PolicyLoweringError extends Error {
  public readonly line: number;
  public readonly column: number;

  constructor(message: string, location: Location) {
    super(`policy error at ${String(location.line)}:${String(location.column)}: ${message}`);
    this.name = "PolicyLoweringError";
    this.line = location.line;
    this.column = location.column;
  }
}

/**
 * A relation declaration paired with its traversal direction:
 * `via === null` is an outgoing edge (`resource --name--> target`), a string is
 * an incoming edge (`target --via--> resource`).
 */
interface RelationInfo {
  readonly declaration: RelationDeclaration;
  readonly via: string | null;
}

interface DefinitionInfo {
  readonly relations: ReadonlyMap<string, RelationInfo>;
  readonly contextSchema: Readonly<Record<string, ContextAttributeType>>;
  readonly permissionNames: ReadonlySet<string>;
  readonly ast: DefinitionAst;
}

/** Lower a parsed policy into the compiled representation's input shape. */
export function lowerPolicyAst(ast: PolicyAst): StructuredPolicy {
  const infos = new Map<string, DefinitionInfo>();
  for (const definition of ast.definitions) {
    if (infos.has(definition.name)) {
      throw new PolicyLoweringError(
        `duplicate definition "${definition.name}"`,
        definition.location,
      );
    }
    infos.set(definition.name, collectDefinition(definition));
  }

  const definitions: Record<string, PolicyDefinition> = {};
  for (const [typeName, info] of infos) {
    definitions[typeName] = lowerDefinition(typeName, info, infos);
  }
  return { definitions };
}

/** Pass 1: gather names and declarations (no expression semantics yet). */
function collectDefinition(definition: DefinitionAst): DefinitionInfo {
  const relations = new Map<string, RelationInfo>();
  for (const relation of definition.relations) {
    if (relations.has(relation.name)) {
      throw new PolicyLoweringError(
        `definition "${definition.name}": duplicate relation "${relation.name}"`,
        relation.location,
      );
    }
    if (relation.subjectTypes.length === 0) {
      throw new PolicyLoweringError(
        `definition "${definition.name}", relation "${relation.name}": at least one type is required`,
        relation.location,
      );
    }
    const seen = new Set<string>();
    for (const subjectType of relation.subjectTypes) {
      if (seen.has(subjectType)) {
        throw new PolicyLoweringError(
          `definition "${definition.name}", relation "${relation.name}": duplicate type "${subjectType}"`,
          relation.location,
        );
      }
      seen.add(subjectType);
    }
    relations.set(relation.name, {
      declaration: { subjectTypes: [...relation.subjectTypes] },
      via: relation.via ?? null,
    });
  }

  const contextSchema: Record<string, ContextAttributeType> = {};
  for (const decl of definition.context) {
    if (Object.prototype.hasOwnProperty.call(contextSchema, decl.key)) {
      throw new PolicyLoweringError(
        `definition "${definition.name}": duplicate context key "${decl.key}"`,
        decl.location,
      );
    }
    contextSchema[decl.key] = decl.type;
  }

  const permissionNames = new Set<string>();
  for (const permission of definition.permissions) {
    if (permissionNames.has(permission.name)) {
      throw new PolicyLoweringError(
        `definition "${definition.name}": duplicate permission "${permission.name}"`,
        permission.location,
      );
    }
    if (relations.has(permission.name)) {
      throw new PolicyLoweringError(
        `definition "${definition.name}": "${permission.name}" is declared as both a relation and a permission`,
        permission.location,
      );
    }
    permissionNames.add(permission.name);
  }

  return { relations, contextSchema, permissionNames, ast: definition };
}

/** Pass 2: lower permission expressions (target definitions now known). */
function lowerDefinition(
  typeName: string,
  info: DefinitionInfo,
  infos: ReadonlyMap<string, DefinitionInfo>,
): PolicyDefinition {
  const permissions: Record<string, PolicyExpression> = {};
  const relations: Record<string, RelationDeclaration> = {};
  for (const [name, relation] of info.relations) {
    relations[name] = relation.declaration;
  }
  for (const permission of info.ast.permissions) {
    const lowered = lowerExpression(permission.expression, {
      typeName,
      permissionName: permission.name,
      info,
      infos,
    });
    // Normalisation: a permission whose body is not an `or` is wrapped in a
    // one-operand `anyOf`. Semantically neutral (OR of one operand is that
    // operand, including `unknown` propagation — ADR-0010), but it keeps a text
    // policy structurally identical to the equivalent structured policy, so
    // content hashes agree. Explanation shape may therefore contain a
    // one-operand wrapper — documented in ADR-0012.
    permissions[permission.name] = lowered.kind === "or" ? lowered : anyOf(lowered);
  }
  return {
    relations,
    permissions,
    ...(Object.keys(info.contextSchema).length === 0 ? {} : { contextSchema: info.contextSchema }),
  };
}

interface LowerContext {
  readonly typeName: string;
  readonly permissionName: string;
  readonly info: DefinitionInfo;
  readonly infos: ReadonlyMap<string, DefinitionInfo>;
}

function lowerExpression(expression: ExpressionAst, ctx: LowerContext): PolicyExpression {
  switch (expression.kind) {
    case "relationRef": {
      if (!ctx.info.relations.has(expression.name)) {
        throw new PolicyLoweringError(
          `definition "${ctx.typeName}", permission "${ctx.permissionName}": undeclared relation "${expression.name}"`,
          expression.location,
        );
      }
      return relationRef(expression.name);
    }
    case "permissionOn": {
      const target = ctx.infos.get(expression.targetType);
      if (target === undefined) {
        throw new PolicyLoweringError(
          `definition "${ctx.typeName}", permission "${ctx.permissionName}": unknown type "${expression.targetType}"`,
          expression.location,
        );
      }
      if (!target.permissionNames.has(expression.permission)) {
        throw new PolicyLoweringError(
          `definition "${ctx.typeName}", permission "${ctx.permissionName}": definition "${expression.targetType}" has no permission "${expression.permission}"`,
          expression.location,
        );
      }
      return lowerTraversal(expression, ctx);
    }
    case "contextEquals": {
      const declared = ctx.info.contextSchema[expression.key];
      if (declared === undefined) {
        const hint = typeof expression.value;
        throw new PolicyLoweringError(
          `definition "${ctx.typeName}", permission "${ctx.permissionName}": context key "${expression.key}" is not declared (add \`context ${expression.key}: ${hint}\`)`,
          expression.location,
        );
      }
      const actual = typeof expression.value;
      if (declared !== actual) {
        throw new PolicyLoweringError(
          `definition "${ctx.typeName}", permission "${ctx.permissionName}": context key "${expression.key}" is declared as ${declared} but compared to a ${actual} literal`,
          expression.location,
        );
      }
      return contextEquals(expression.key, expression.value);
    }
    case "and":
      return allOf(...expression.operands.map((operand) => lowerExpression(operand, ctx)));
    case "or":
      return anyOf(...expression.operands.map((operand) => lowerExpression(operand, ctx)));
  }
}

/**
 * Resolve `targetType.permission` into a traversal over the declaration that
 * links the current definition to `targetType`. Exactly one such declaration is
 * required: zero means the author forgot the edge, and more than one is
 * ambiguous and must be disambiguated (there is no precedence guessing in a
 * security-sensitive language).
 */
function lowerTraversal(
  expression: Extract<ExpressionAst, { kind: "permissionOn" }>,
  ctx: LowerContext,
): PolicyExpression {
  const outgoing: string[] = [];
  const incoming: { readonly alias: string; readonly edge: string }[] = [];
  for (const [name, relation] of ctx.info.relations) {
    if (!relation.declaration.subjectTypes.includes(expression.targetType)) continue;
    if (relation.via === null) {
      outgoing.push(name);
    } else {
      incoming.push({ alias: name, edge: relation.via });
    }
  }

  const total = outgoing.length + incoming.length;
  const where = `definition "${ctx.typeName}", permission "${ctx.permissionName}", "${expression.targetType}.${expression.permission}"`;
  if (total === 0) {
    throw new PolicyLoweringError(
      `${where}: no relation in definition "${ctx.typeName}" links to type "${expression.targetType}" (declare \`relation <name>: ${expression.targetType}\` or \`relation <name>: ${expression.targetType} via <edge>\`)`,
      expression.location,
    );
  }
  if (total > 1) {
    const candidates = [...outgoing, ...incoming.map((i) => `${i.alias} via ${i.edge}`)].join(", ");
    throw new PolicyLoweringError(
      `${where}: ambiguous — ${String(total)} relations link to type "${expression.targetType}" (${candidates})`,
      expression.location,
    );
  }

  const direct = outgoing[0];
  if (direct !== undefined) {
    return indirectRef(direct, expression.permission, false);
  }
  const reverse = incoming[0] as { readonly alias: string; readonly edge: string };
  return indirectRef(reverse.edge, expression.permission, true);
}
