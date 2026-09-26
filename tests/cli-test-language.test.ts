import { describe, expect, it } from "vitest";
import { PolicySyntaxError } from "../packages/policy/src/index.js";
import { parseTestFile } from "../packages/cli/src/index.js";

describe("policy test language parser (ADR-0014)", () => {
  it("parses given, context, and assertions in one block", () => {
    const blocks = parseTestFile(
      [
        'test "owners can write" {',
        "  given {",
        "    user:alice owner project:alpha",
        "  }",
        "  context {",
        "    mfa: true",
        '    device: "managed"',
        "  }",
        "  check(user:alice, project.write, project:alpha) == allow",
        "}",
      ].join("\n"),
    );

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block).toBeDefined();
    if (block === undefined) return;
    expect(block.name).toBe("owners can write");
    expect(block.given).toEqual([
      {
        subject: "user:alice",
        relation: "owner",
        resource: "project:alpha",
        location: { line: 3, column: 5 },
      },
    ]);
    expect(block.context).toEqual({ mfa: true, device: "managed" });
    expect(block.assertions).toHaveLength(1);
    expect(block.assertions[0]?.target).toBe("allow");
  });

  it("records a canonical source form for failure reporting", () => {
    const [block] = parseTestFile(
      'test "t" {\n  check(user:bob, project.delete, project:alpha) == deny\n}\n',
    );
    expect(block).toBeDefined();
    expect(block?.assertions[0]?.source).toBe(
      "check(user:bob, project.delete, project:alpha) == deny",
    );
    // The location points at the subject that starts the assertion.
    expect(block?.assertions[0]?.location).toEqual({ line: 2, column: 9 });
  });

  it("supports allow, deny, and error targets", () => {
    const [block] = parseTestFile(
      [
        'test "t" {',
        "  check(user:a, x.read, x:1) == allow",
        "  check(user:a, x.read, x:2) == deny",
        "  check(user:a, x.read, x:3) == error",
        "}",
      ].join("\n"),
    );
    expect(block).toBeDefined();
    expect(block?.assertions.map((a) => a.target)).toEqual(["allow", "deny", "error"]);
  });

  it("parses multiple blocks in source order", () => {
    const blocks = parseTestFile(
      [
        'test "first" {',
        "  check(user:a, x.read, x:1) == allow",
        "}",
        'test "second" {',
        "  check(user:a, x.read, x:2) == deny",
        "}",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.name)).toEqual(["first", "second"]);
  });

  it("keeps identifiers containing punctuation as one token run", () => {
    // Adjacency is what terminates a run, so a dotted/hyphenated id survives.
    const [block] = parseTestFile(
      'test "t" {\n  check(user:first.last, document.read, document:a-b.c) == allow\n}\n',
    );
    expect(block).toBeDefined();
    expect(block?.assertions[0]?.resource).toBe("document:a-b.c");
    expect(block?.assertions[0]?.subject).toBe("user:first.last");
  });

  it("rejects an empty file", () => {
    expect(() => parseTestFile("// only a comment\n")).toThrow(/contains no `test` blocks/u);
  });

  it("rejects an unterminated test block", () => {
    expect(() => parseTestFile('test "t" {\n  check(user:a, x.read, x:1) == allow\n')).toThrow(
      /unterminated `test` block/u,
    );
  });

  it("rejects an unterminated given block", () => {
    expect(() => parseTestFile('test "t" {\n  given {\n    user:a owner x:1\n}\n')).toThrow(
      PolicySyntaxError,
    );
  });

  it("rejects a test with no assertions", () => {
    // A test that asserts nothing would always pass; that is not a test.
    expect(() => parseTestFile('test "empty" {\n}\n')).toThrow(/has no assertions/u);
  });

  it("rejects given/context placed after the first assertion", () => {
    expect(() =>
      parseTestFile(
        'test "t" {\n  check(user:a, x.read, x:1) == allow\n  given {\n    user:b owner x:1\n  }\n}\n',
      ),
    ).toThrow(/must appear before the first check assertion/u);
  });

  it("rejects duplicate given and duplicate context blocks", () => {
    expect(() =>
      parseTestFile(
        'test "t" {\n  given {\n    user:a owner x:1\n  }\n  given {\n    user:b owner x:1\n  }\n  check(user:a, x.read, x:1) == allow\n}\n',
      ),
    ).toThrow(/at most once/u);
  });

  it("rejects an unknown target", () => {
    expect(() => parseTestFile('test "t" {\n  check(user:a, x.read, x:1) == maybe\n}\n')).toThrow(
      /expected "allow", "deny", or "error"/u,
    );
  });

  it("rejects a missing ==", () => {
    expect(() => parseTestFile('test "t" {\n  check(user:a, x.read, x:1) allow\n}\n')).toThrow(
      /expected "=="/u,
    );
  });

  it("rejects malformed identifiers with a source position", () => {
    try {
      parseTestFile('test "t" {\n  check(nocolon, x.read, x:1) == allow\n}\n');
      expect.unreachable("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicySyntaxError);
      expect((error as PolicySyntaxError).line).toBe(2);
    }
  });

  it("rejects an unknown statement inside a block", () => {
    expect(() => parseTestFile('test "t" {\n  assert(user:a, x.read, x:1)\n}\n')).toThrow(
      /expected "given", "context", or a check assertion/u,
    );
  });

  it("rejects a missing test name string", () => {
    expect(() => parseTestFile("test {\n}\n")).toThrow(/expected a test name string/u);
  });
});
