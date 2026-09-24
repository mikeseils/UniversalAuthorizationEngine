import { describe, expect, it } from "vitest";
import { MAX_SOURCE_LENGTH, PolicySyntaxError, tokenize } from "../packages/policy/src/index.js";

const kinds = (source: string) => tokenize(source).map((t) => t.type);
const values = (source: string) => tokenize(source).map((t) => t.value);

describe("policy lexer (ADR-0012)", () => {
  it("tokenizes keywords, identifiers, punctuation, and literals", () => {
    const tokens = tokenize(
      "definition project { relation owner: user permission read = context.mfa == true }",
    );
    expect(tokens[0]).toEqual({ type: "keyword", value: "definition", line: 1, column: 1 });
    expect(tokens[1]).toEqual({ type: "ident", value: "project", line: 1, column: 12 });
    expect(tokens[tokens.length - 1]?.type).toBe("eof");
    expect(values("relation owner: user")).toEqual(["relation", "owner", ":", "user", ""]);
  });

  it("tracks line and column across newlines", () => {
    const tokens = tokenize("definition a {\n  relation x: user\n}");
    const relation = tokens.find((t) => t.value === "relation");
    expect(relation).toEqual({ type: "keyword", value: "relation", line: 2, column: 3 });
  });

  it("skips line and block comments", () => {
    const tokens = tokenize("// leading\n/* block\n   spanning */\ndefinition a { }");
    expect(tokens[0]?.value).toBe("definition");
    expect(tokens[0]?.line).toBe(4);
  });

  it("decodes string escapes and rejects unsupported ones", () => {
    expect(tokenize('"a\\"b"')[0]?.value).toBe('a"b');
    expect(() => tokenize('"a\\tb"')).toThrow(PolicySyntaxError);
  });

  it("lexes negative numbers as punctuation plus number", () => {
    expect(kinds("-5")).toEqual(["punct", "number", "eof"]);
  });

  it("rejects unterminated strings, block comments, and unknown characters", () => {
    expect(() => tokenize('"unterminated')).toThrow(/unterminated string literal/);
    expect(() => tokenize("/* unterminated")).toThrow(/unterminated block comment/);
    expect(() => tokenize("definition a { # }")).toThrow(/unexpected character "#"/);
  });

  it("rejects source beyond the length cap before doing any work", () => {
    const huge = "a".repeat(MAX_SOURCE_LENGTH + 1);
    expect(() => tokenize(huge)).toThrow(/exceeds/);
  });

  it("tolerates a leading UTF-8 BOM from Windows editors", () => {
    const tokens = tokenize("\uFEFFdefinition a { }");
    expect(tokens[0]).toEqual({ type: "keyword", value: "definition", line: 1, column: 1 });
  });

  it("reports positions in error messages", () => {
    try {
      tokenize("definition a {\n  @\n}");
      expect.unreachable("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicySyntaxError);
      const syntaxError = error as PolicySyntaxError;
      expect(syntaxError.line).toBe(2);
      expect(syntaxError.column).toBe(3);
    }
  });
});
