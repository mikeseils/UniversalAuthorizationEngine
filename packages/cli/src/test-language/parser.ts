import { ContextLiteral, Location, PolicySyntaxError, Token, tokenize } from "@uae/policy";
import { parseAction, parseIdentifier, parseRelationship } from "@uae/core";

/**
 * Policy test file grammar v1 (ADR-0014). Separate from the policy language,
 * sharing its tokenizer (positions, literals, comments) so there is one
 * implementation of lexical concerns.
 *
 * ```
 * test "owners can write" {
 *   given {
 *     user:alice owner project:alpha
 *   }
 *   context {
 *     mfa: true
 *   }
 *   check(user:alice, project.write, project:alpha) == allow
 * }
 * ```
 *
 * Identifiers are read as *adjacent token runs* (`document:a-b.c` survives the
 * tokenizer), then validated with the core parsers, so malformed input is
 * rejected with a source position rather than being coerced.
 */

export type TestTarget = "allow" | "deny" | "error";

export interface TestTuple {
  readonly subject: string;
  readonly relation: string;
  readonly resource: string;
  readonly location: Location;
}

export interface TestAssertion {
  /** Canonical source form, for failure reporting. */
  readonly source: string;
  readonly subject: string;
  readonly action: string;
  readonly resource: string;
  readonly target: TestTarget;
  readonly location: Location;
}

export interface TestBlock {
  readonly name: string;
  readonly given: readonly TestTuple[];
  readonly context: Readonly<Record<string, ContextLiteral>>;
  readonly assertions: readonly TestAssertion[];
  /** Where the test name starts (line/column of the string literal). */
  readonly location: Location;
}

/** Parse a `*.test.authz` file. Throws {@link PolicySyntaxError} with positions. */
export function parseTestFile(source: string): readonly TestBlock[] {
  return new TestParser(tokenize(source)).parseFile();
}

const loc = (token: Token): Location => ({ line: token.line, column: token.column });

function isAdjacent(previous: Token, next: Token): boolean {
  return previous.line === next.line && next.column === previous.column + previous.value.length;
}

function describe(token: Token): string {
  if (token.type === "eof") return "end of input";
  return `"${token.value}"`;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TestParser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parseFile(): readonly TestBlock[] {
    const blocks: TestBlock[] = [];
    while (this.peek().type !== "eof") {
      blocks.push(this.parseBlock());
    }
    if (blocks.length === 0) {
      throw this.error("test file contains no `test` blocks");
    }
    return blocks;
  }

  private parseBlock(): TestBlock {
    this.expectName("test");
    const nameToken = this.peek();
    if (nameToken.type !== "string") {
      throw this.error(`expected a test name string, found ${describe(nameToken)}`);
    }
    this.advance();
    const name = nameToken.value;
    this.expectPunct("{");

    const given: TestTuple[] = [];
    const context: Record<string, ContextLiteral> = {};
    const assertions: TestAssertion[] = [];
    let seenGiven = false;
    let seenContext = false;

    while (!this.atPunct("}")) {
      if (this.peek().type === "eof") {
        throw this.error("unterminated `test` block");
      }
      if (this.atName("given")) {
        this.requireBeforeAssertions(assertions, "given");
        if (seenGiven) throw this.error("`given` may appear at most once per test");
        seenGiven = true;
        given.push(...this.parseGiven());
        continue;
      }
      if (this.atName("context")) {
        this.requireBeforeAssertions(assertions, "context");
        if (seenContext) throw this.error("`context` may appear at most once per test");
        seenContext = true;
        Object.assign(context, this.parseContext());
        continue;
      }
      if (this.atName("check")) {
        assertions.push(this.parseAssertion());
        continue;
      }
      throw this.error(
        `expected "given", "context", or a check assertion, found ${describe(this.peek())}`,
      );
    }
    this.expectPunct("}");

    if (assertions.length === 0) {
      throw new PolicySyntaxError(
        `test "${name}" has no assertions (a test that asserts nothing always passes)`,
        nameToken.line,
        nameToken.column,
      );
    }
    return { name, given, context, assertions, location: loc(nameToken) };
  }

  private requireBeforeAssertions(assertions: readonly TestAssertion[], what: string): void {
    if (assertions.length > 0) {
      throw this.error(`\`${what}\` must appear before the first check assertion`);
    }
  }

  private parseGiven(): readonly TestTuple[] {
    this.expectName("given");
    this.expectPunct("{");
    const tuples: TestTuple[] = [];
    while (!this.atPunct("}")) {
      if (this.peek().type === "eof") {
        throw this.error("unterminated `given` block");
      }
      tuples.push(this.parseTuple());
    }
    this.expectPunct("}");
    return tuples;
  }

  /** `subject relation resource`, all three validated by the core parsers. */
  private parseTuple(): TestTuple {
    const subject = this.readRun("a subject");
    const relation = this.readRun("a relation");
    const resource = this.readRun("a resource");
    try {
      const rel = parseRelationship({
        subject: subject.text,
        relation: relation.text,
        resource: resource.text,
      });
      return {
        subject: `${rel.subject.type}:${rel.subject.id}`,
        relation: rel.relation,
        resource: `${rel.resource.type}:${rel.resource.id}`,
        location: subject.location,
      };
    } catch (error) {
      throw this.syntaxError(reason(error), subject.location);
    }
  }

  private parseContext(): Readonly<Record<string, ContextLiteral>> {
    this.expectName("context");
    this.expectPunct("{");
    const context: Record<string, ContextLiteral> = {};
    while (!this.atPunct("}")) {
      if (this.peek().type === "eof") {
        throw this.error("unterminated `context` block");
      }
      const keyToken = this.peek();
      if (keyToken.type !== "ident" && keyToken.type !== "keyword") {
        throw this.error(`expected a context key, found ${describe(keyToken)}`);
      }
      this.advance();
      const key = keyToken.value;
      if (Object.prototype.hasOwnProperty.call(context, key)) {
        throw this.syntaxError(`duplicate context key "${key}"`, loc(keyToken));
      }
      this.expectPunct(":");
      context[key] = this.parseLiteral();
    }
    this.expectPunct("}");
    return context;
  }

  private parseAssertion(): TestAssertion {
    this.expectName("check");
    this.expectPunct("(");
    const subject = this.readRun("a subject");
    this.expectPunct(",");
    const action = this.readRun("an action");
    this.expectPunct(",");
    const resource = this.readRun("a resource");
    this.expectPunct(")");
    this.expectEquals();
    const targetToken = this.peek();
    const target = targetToken.type === "ident" ? targetToken.value : "";
    if (target !== "allow" && target !== "deny" && target !== "error") {
      throw this.error(`expected "allow", "deny", or "error", found ${describe(targetToken)}`);
    }
    this.advance();

    this.requireIdentifier(subject.text, subject.location);
    this.requireAction(action.text, action.location);
    this.requireIdentifier(resource.text, resource.location);

    return {
      source: `check(${subject.text}, ${action.text}, ${resource.text}) == ${target}`,
      subject: subject.text,
      action: action.text,
      resource: resource.text,
      target,
      location: subject.location,
    };
  }

  private requireIdentifier(text: string, location: Location): void {
    try {
      parseIdentifier(text);
    } catch (error) {
      throw this.syntaxError(reason(error), location);
    }
  }

  private requireAction(text: string, location: Location): void {
    try {
      parseAction(text);
    } catch (error) {
      throw this.syntaxError(reason(error), location);
    }
  }

  private parseLiteral(): ContextLiteral {
    const token = this.peek();
    if (token.type === "keyword" && (token.value === "true" || token.value === "false")) {
      this.advance();
      return token.value === "true";
    }
    if (token.type === "string") {
      this.advance();
      return token.value;
    }
    if (token.type === "number") {
      this.advance();
      return this.toNumber(token.value, token);
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
    throw this.error(
      `expected a literal (string, number, true, or false), found ${describe(token)}`,
    );
  }

  private toNumber(raw: string, token: Token): number {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw this.syntaxError(`number literal out of range: "${raw}"`, loc(token));
    }
    return parsed;
  }

  /**
   * Read a maximal run of adjacent identifier-forming tokens. Adjacency (same
   * line, contiguous columns) is what terminates a run at whitespace, so
   * `user:alice owner project:alpha` yields three runs while `document:a-b.c`
   * stays one.
   */
  private readRun(what: string): { readonly text: string; readonly location: Location } {
    const start = this.peek();
    let text = "";
    let previous: Token | undefined;
    for (;;) {
      const token = this.peek();
      if (token.type === "eof" || !isRunToken(token)) break;
      if (previous !== undefined && !isAdjacent(previous, token)) break;
      text += token.value;
      previous = token;
      this.advance();
    }
    if (text === "") {
      throw this.error(`expected ${what}, found ${describe(this.peek())}`);
    }
    return { text, location: loc(start) };
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

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.type === "punct" && token.value === value;
  }

  private atName(value: string): boolean {
    const token = this.peek();
    return (token.type === "ident" || token.type === "keyword") && token.value === value;
  }

  private expectName(value: string): Token {
    if (!this.atName(value)) {
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

  /** Accept `==` (lexed as two `=` tokens, the same convention as the language). */
  private expectEquals(): void {
    const first = this.peek();
    const second = this.tokens[this.pos + 1];
    if (
      first.type === "punct" &&
      first.value === "=" &&
      second !== undefined &&
      second.type === "punct" &&
      second.value === "="
    ) {
      this.advance();
      this.advance();
      return;
    }
    throw this.error(`expected "==", found ${describe(first)}`);
  }

  private error(message: string): PolicySyntaxError {
    const token = this.peek();
    return new PolicySyntaxError(message, token.line, token.column);
  }

  private syntaxError(message: string, location: Location): PolicySyntaxError {
    return new PolicySyntaxError(message, location.line, location.column);
  }
}

function isRunToken(token: Token): boolean {
  if (token.type === "ident" || token.type === "keyword" || token.type === "number") return true;
  return (
    token.type === "punct" && (token.value === ":" || token.value === "." || token.value === "-")
  );
}
