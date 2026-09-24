import {
  ContextDeclAst,
  DefinitionAst,
  ExpressionAst,
  Location,
  PermissionAst,
  PolicyAst,
  RelationAst,
} from "./ast.js";
import { PolicySyntaxError, Token, tokenize } from "./lexer.js";

const CONTEXT_TYPES = new Set(["string", "number", "boolean"]);

/**
 * Expression nesting cap. Recovery-free recursion is bounded by this so that
 * pathological input (e.g. 100k nested parentheses, which fits inside
 * `MAX_SOURCE_LENGTH`) fails as a typed syntax error instead of exhausting the
 * call stack and surfacing as an opaque `RangeError`.
 */
export const MAX_EXPRESSION_DEPTH = 64;

/**
 * Recursive-descent parser for the ADR-0012 grammar. There is no backtracking,
 * so parsing terminates on any input that fits the source cap.
 */
export function parsePolicy(source: string): PolicyAst {
  return new Parser(tokenize(source)).parsePolicy();
}

const loc = (token: Token): Location => ({ line: token.line, column: token.column });

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parsePolicy(): PolicyAst {
    const definitions: DefinitionAst[] = [];
    while (this.peek().type !== "eof") {
      definitions.push(this.parseDefinition());
    }
    if (definitions.length === 0) {
      throw this.error("policy must contain at least one definition");
    }
    return { definitions };
  }

  private parseDefinition(): DefinitionAst {
    const start = this.expectKeyword("definition");
    const name = this.expectIdent("definition name");
    this.expectPunct("{");
    const relations: RelationAst[] = [];
    const context: ContextDeclAst[] = [];
    const permissions: PermissionAst[] = [];
    while (!this.atPunct("}")) {
      if (this.atKeyword("relation")) {
        relations.push(this.parseRelation());
      } else if (this.atKeyword("context")) {
        context.push(this.parseContextDecl());
      } else if (this.atKeyword("permission")) {
        permissions.push(this.parsePermission());
      } else {
        throw this.error(
          `expected "relation", "context", or "permission", found ${describe(this.peek())}`,
        );
      }
    }
    this.expectPunct("}");
    return { name, relations, context, permissions, location: loc(start) };
  }

  private parseRelation(): RelationAst {
    const start = this.expectKeyword("relation");
    const name = this.expectIdent("relation name");
    this.expectPunct(":");
    const subjectTypes: string[] = [this.expectIdent("relation type")];
    while (this.atPunct(",")) {
      this.expectPunct(",");
      subjectTypes.push(this.expectIdent("relation type"));
    }
    let via: string | undefined;
    if (this.atKeyword("via")) {
      this.expectKeyword("via");
      via = this.expectIdent("edge name after `via`");
    }
    const location = loc(start);
    return via === undefined
      ? { name, subjectTypes, location }
      : { name, subjectTypes, via, location };
  }

  private parseContextDecl(): ContextDeclAst {
    const start = this.expectKeyword("context");
    const key = this.expectIdent("context key");
    this.expectPunct(":");
    const typeToken = this.peek();
    if (typeToken.type !== "keyword" || !CONTEXT_TYPES.has(typeToken.value)) {
      throw this.error(`expected "string", "number", or "boolean", found ${describe(typeToken)}`);
    }
    this.advance();
    return { key, type: typeToken.value as ContextDeclAst["type"], location: loc(start) };
  }

  private parsePermission(): PermissionAst {
    const start = this.expectKeyword("permission");
    const name = this.expectIdent("permission name");
    this.expectPunct("=");
    const expression = this.parseOr();
    return { name, expression, location: loc(start) };
  }

  // expression parsing -------------------------------------------------------

  private parseOr(): ExpressionAst {
    const first = this.parseAnd();
    if (!this.atKeyword("or")) return first;
    const operands: ExpressionAst[] = [first];
    let connective = this.peek();
    while (this.atKeyword("or")) {
      connective = this.advance();
      operands.push(this.parseAnd());
    }
    return { kind: "or", operands, location: loc(connective) };
  }

  private parseAnd(): ExpressionAst {
    const first = this.parseUnary();
    if (!this.atKeyword("and")) return first;
    const operands: ExpressionAst[] = [first];
    let connective = this.peek();
    while (this.atKeyword("and")) {
      connective = this.advance();
      operands.push(this.parseUnary());
    }
    return { kind: "and", operands, location: loc(connective) };
  }

  private parseUnary(): ExpressionAst {
    const token = this.peek();
    if (token.type === "keyword" && token.value === "not") {
      // Negation is deliberately absent from language v1 (ADR-0012): a
      // negation-based grant is almost always an authoring mistake.
      throw this.error(
        "negation is not supported in policy language v1 (use an explicit relation)",
      );
    }
    return this.parseAtom();
  }

  private parseAtom(): ExpressionAst {
    const token = this.peek();
    if (this.atPunct("(")) {
      const open = this.advance();
      this.depth += 1;
      if (this.depth > MAX_EXPRESSION_DEPTH) {
        throw new PolicySyntaxError(
          `expression nesting exceeds ${String(MAX_EXPRESSION_DEPTH)} levels`,
          open.line,
          open.column,
        );
      }
      const inner = this.parseOr();
      this.expectPunct(")");
      this.depth -= 1;
      return inner;
    }
    if (token.type === "ident") {
      this.advance();
      if (this.atPunct(".")) {
        this.expectPunct(".");
        const permission = this.expectIdent("permission name after '.'");
        return { kind: "permissionOn", targetType: token.value, permission, location: loc(token) };
      }
      return { kind: "relationRef", name: token.value, location: loc(token) };
    }
    if (token.type === "keyword" && token.value === "context") {
      this.advance();
      this.expectPunct(".");
      const key = this.expectIdent("context key after 'context.'");
      this.expectEquals();
      return { kind: "contextEquals", key, value: this.parseLiteral(), location: loc(token) };
    }
    throw this.error(`expected an expression, found ${describe(token)}`);
  }

  private parseLiteral(): string | number | boolean {
    const token = this.peek();
    if (token.type === "keyword" && (token.value === "true" || token.value === "false")) {
      this.advance();
      return token.value === "true";
    }
    if (token.type === "punct" && token.value === "-") {
      this.advance();
      const numberToken = this.peek();
      if (numberToken.type !== "number") {
        throw this.error(`expected a number after "-", found ${describe(numberToken)}`);
      }
      this.advance();
      return this.toNumber(`-${numberToken.value}`, numberToken);
    }
    if (token.type === "number") {
      this.advance();
      return this.toNumber(token.value, token);
    }
    if (token.type === "string") {
      this.advance();
      return token.value;
    }
    throw this.error(
      `expected a literal (true, false, number, or "string"), found ${describe(token)}`,
    );
  }

  private toNumber(raw: string, token: Token): number {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw new PolicySyntaxError(
        `number literal out of range: "${raw}"`,
        token.line,
        token.column,
      );
    }
    return parsed;
  }

  // token stream helpers -----------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.type !== "eof") this.pos += 1;
    return token;
  }

  private atKeyword(value: string): boolean {
    const token = this.peek();
    return token.type === "keyword" && token.value === value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.type === "punct" && token.value === value;
  }

  private expectKeyword(value: string): Token {
    if (!this.atKeyword(value)) {
      throw this.error(`expected "${value}", found ${describe(this.peek())}`);
    }
    return this.advance();
  }

  private expectPunct(value: string): Token {
    if (!this.atPunct(value)) {
      throw this.error(`expected "${value}", found ${describe(this.peek())}`);
    }
    return this.advance();
  }

  /** Accept `==` (lexed as two `=` tokens); a lone `=` is an error here. */
  private expectEquals(): void {
    const token = this.peek();
    const next = this.tokens[this.pos + 1];
    if (
      token.type === "punct" &&
      token.value === "=" &&
      next !== undefined &&
      next.type === "punct" &&
      next.value === "="
    ) {
      this.advance();
      this.advance();
      return;
    }
    throw this.error(`expected "==", found ${describe(token)}`);
  }

  private expectIdent(what: string): string {
    const token = this.peek();
    if (token.type !== "ident") {
      throw this.error(`expected ${what}, found ${describe(token)}`);
    }
    return this.advance().value;
  }

  private error(message: string): PolicySyntaxError {
    const token = this.peek();
    return new PolicySyntaxError(message, token.line, token.column);
  }
}

function describe(token: Token): string {
  if (token.type === "eof") return "end of input";
  return `"${token.value}"`;
}
