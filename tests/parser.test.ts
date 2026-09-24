import { describe, expect, it } from "vitest";
import {
  MAX_EXPRESSION_DEPTH,
  PolicySyntaxError,
  parsePolicy,
} from "../packages/policy/src/index.js";

const parse = (source: string) => parsePolicy(source);

describe("policy parser (ADR-0012 grammar)", () => {
  it("parses definitions, relations, context declarations, and permissions", () => {
    const ast = parse(`
      definition project {
        relation owner: user
        relation editor: user, service
        context mfa: boolean
        permission write = editor or owner
      }
    `);
    expect(ast.definitions).toHaveLength(1);
    const definition = ast.definitions[0];
    expect(definition?.name).toBe("project");
    expect(definition?.relations.map((r) => [r.name, r.subjectTypes])).toEqual([
      ["owner", ["user"]],
      ["editor", ["user", "service"]],
    ]);
    expect(definition?.context).toEqual([
      { key: "mfa", type: "boolean", location: expect.any(Object) as unknown },
    ]);
    expect(definition?.permissions[0]?.name).toBe("write");
    expect(definition?.permissions[0]?.expression.kind).toBe("or");
  });

  it("parses `via` declarations", () => {
    const ast = parse("definition document { relation project: project via contains }");
    expect(ast.definitions[0]?.relations[0]?.via).toBe("contains");
  });

  it("applies and/or precedence and parentheses", () => {
    const exprOf = (source: string) =>
      parse(
        `definition d { relation a: user relation b: user relation c: user permission p = ${source} }`,
      ).definitions[0]?.permissions[0]?.expression;

    expect(exprOf("a and b or c")?.kind).toBe("or");
    const orExpr = exprOf("a or b and c");
    expect(orExpr).toMatchObject({
      kind: "or",
      operands: [{ kind: "relationRef" }, { kind: "and" }],
    });
    const parenExpr = exprOf("(a or b) and c");
    expect(parenExpr).toMatchObject({
      kind: "and",
      operands: [{ kind: "or" }, { kind: "relationRef" }],
    });
  });

  it("parses target-type permission references and context conditions", () => {
    const expr = parse(`
      definition invoice {
        context amount: number
        relation approver: user
        permission approve = approver and context.amount == -5 and context.approver_name == "bob" or context.flag == true
      }
    `).definitions[0]?.permissions[0]?.expression;
    const json = JSON.stringify(expr);
    expect(json).toContain('"kind":"contextEquals"');
    expect(json).toContain('"value":-5');
    expect(json).toContain('"value":"bob"');
    expect(json).toContain('"value":true');
  });

  it("records source locations for diagnostics", () => {
    const ast = parse("definition a { }\ndefinition b { }");
    expect(ast.definitions[1]?.location).toEqual({ line: 2, column: 1 });
  });

  it.each([
    ["", /policy must contain at least one definition/],
    ["  \n  ", /policy must contain at least one definition/],
    ["definition", /expected definition name, found end of input/],
    ["definition a", /expected "\{", found end of input/],
    ["definition a { foo: user }", /expected "relation", "context", or "permission", found "foo"/],
    ["definition a { relation x: }", /expected relation type, found "\}"/],
    ["definition a { relation x: user via }", /expected edge name after `via`, found "\}"/],
    ["definition a { context mfa: int }", /expected "string", "number", or "boolean", found "int"/],
    ["definition a { relation x: user permission p x }", /expected "=", found "x"/],
    ["definition a { relation x: user permission p = }", /expected an expression, found "\}"/],
    [
      "definition a { context mfa: boolean relation x: user permission p = context.mfa = true }",
      /expected "==", found "="/,
    ],
    [
      "definition a { relation x: user permission p = not x }",
      /negation is not supported in policy language v1/,
    ],
    [
      "definition a { context n: number permission p = context.n == 99999999999999999999 }",
      /number literal out of range/,
    ],
    ["definition a { } trailing", /expected "definition", found "trailing"/],
  ])("rejects malformed source %s", (source, pattern) => {
    expect(() => parse(source)).toThrow(pattern);
  });

  it("reports errors with line and column", () => {
    try {
      parse("definition a {\n  relation x: user\n  bogus y: user\n}");
      expect.unreachable("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicySyntaxError);
      const syntaxError = error as PolicySyntaxError;
      expect(syntaxError.line).toBe(3);
      expect(syntaxError.column).toBe(3);
      expect(syntaxError.message).toMatch(/^policy syntax error at 3:3:/);
    }
  });

  it("bounds nesting depth instead of overflowing the stack", () => {
    const nested = (depth: number) =>
      `definition a { relation x: user permission p = ${"(".repeat(depth)}x${")".repeat(depth)} }`;
    // Exactly at the cap is fine; one level deeper is a typed syntax error
    // (note MAX_SOURCE_LENGTH alone would allow ~100k levels of recursion).
    expect(() => parse(nested(MAX_EXPRESSION_DEPTH))).not.toThrow();
    expect(() => parse(nested(MAX_EXPRESSION_DEPTH + 1))).toThrow(
      /expression nesting exceeds 64 levels/,
    );
    expect(() => parse(nested(500))).toThrow(PolicySyntaxError);
    // Same cap applies to unbalanced input.
    expect(() =>
      parse(`definition a { relation x: user permission p = ${"(".repeat(500)}x }`),
    ).toThrow(PolicySyntaxError);
  });

  it("rejects a minus sign without a number", () => {
    expect(() => parse("definition a { context n: number permission p = context.n == - }")).toThrow(
      /expected a number after "-"/,
    );
  });
});
