/** Source input cap — parsing cost is bounded by design (ADR-0012). */
export const MAX_SOURCE_LENGTH = 256 * 1024;

/** Raised for malformed policy text with a precise location. */
export class PolicySyntaxError extends Error {
  public readonly line: number;
  public readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`policy syntax error at ${String(line)}:${String(column)}: ${message}`);
    this.name = "PolicySyntaxError";
    this.line = line;
    this.column = column;
  }
}

export type TokenType = "ident" | "keyword" | "number" | "string" | "punct" | "eof";

export interface Token {
  readonly type: TokenType;
  /** Raw text (identifiers/keywords/punctuation) or decoded value. */
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

const KEYWORDS = new Set([
  "definition",
  "relation",
  "permission",
  "context",
  "via",
  "and",
  "or",
  "not",
  "true",
  "false",
  "string",
  "number",
  "boolean",
]);

const PUNCT = new Set(["{", "}", ":", ",", ".", "=", "(", ")", "-"]);

const IDENT_START = /[a-zA-Z_]/u;
const IDENT_PART = /[a-zA-Z0-9_]/u;

export function tokenize(rawSource: string): Token[] {
  // A UTF-8 BOM is an encoding artifact, not malformed policy text — Windows
  // editors add one routinely. Strip it so authors never get a confusing
  // error at line 1, column 1.
  const source = rawSource.charCodeAt(0) === 0xfeff ? rawSource.slice(1) : rawSource;
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new PolicySyntaxError(
      `policy source exceeds ${String(MAX_SOURCE_LENGTH)} characters`,
      1,
      1,
    );
  }
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (): void => {
    if (source[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    i += 1;
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const startLine = line;
      const startCol = col;
      advance();
      advance();
      let closed = false;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          advance();
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        throw new PolicySyntaxError("unterminated block comment", startLine, startCol);
      }
      continue;
    }
    const tokenLine = line;
    const tokenCol = col;
    const current: string = source[i] as string;
    if (PUNCT.has(current)) {
      tokens.push({ type: "punct", value: current, line: tokenLine, column: tokenCol });
      advance();
      continue;
    }
    if (current === '"') {
      advance();
      let value = "";
      let closed = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '"') {
          advance();
          closed = true;
          break;
        }
        if (c === "\n") break;
        if (c === "\\") {
          advance();
          const esc = source[i];
          if (esc === '"' || esc === "\\") {
            value += esc;
            advance();
          } else {
            throw new PolicySyntaxError(`unsupported escape "\\${esc ?? ""}"`, tokenLine, tokenCol);
          }
          continue;
        }
        value += c;
        advance();
      }
      if (!closed) {
        throw new PolicySyntaxError("unterminated string literal", tokenLine, tokenCol);
      }
      tokens.push({ type: "string", value, line: tokenLine, column: tokenCol });
      continue;
    }
    if (current >= "0" && current <= "9") {
      let value = "";
      while (i < source.length) {
        const c: string = source[i] as string;
        if (c < "0" || c > "9") break;
        value += c;
        advance();
      }
      tokens.push({ type: "number", value, line: tokenLine, column: tokenCol });
      continue;
    }
    if (IDENT_START.test(current)) {
      let value = "";
      while (i < source.length) {
        const c: string = source[i] as string;
        if (!IDENT_PART.test(c)) break;
        value += c;
        advance();
      }
      const type: TokenType = KEYWORDS.has(value) ? "keyword" : "ident";
      tokens.push({ type, value, line: tokenLine, column: tokenCol });
      continue;
    }
    throw new PolicySyntaxError(`unexpected character "${current}"`, tokenLine, tokenCol);
  }

  tokens.push({ type: "eof", value: "", line, column: col });
  return tokens;
}
