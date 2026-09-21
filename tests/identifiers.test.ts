import { describe, expect, it } from "vitest";
import {
  formatIdentifier,
  isValidIdentifier,
  parseIdentifier,
  tryParseIdentifier,
  ValidationError,
} from "../packages/core/src/index.js";

describe("parseIdentifier", () => {
  it.each([
    "user:alice",
    "agent:support-42",
    "service:billing",
    "external_user:bob@example.com",
    "document:a",
    "project:123",
  ])("accepts %s", (input) => {
    const parsed = parseIdentifier(input);
    expect(parsed.type.length).toBeGreaterThan(0);
    expect(parsed.id.length).toBeGreaterThan(0);
    expect(formatIdentifier(parsed)).toBe(input);
  });

  it.each([
    "",
    "alice",
    ":alice",
    "user:",
    "user:alice:extra",
    "User:alice",
    "user: alice",
    "user:al ice",
    42,
    null,
    undefined,
    {},
    ["user:alice"],
  ])("rejects %s", (input) => {
    expect(() => parseIdentifier(input)).toThrow(ValidationError);
  });

  it("rejects whitespace-only ids and ids containing ':'", () => {
    expect(() => parseIdentifier("user:a:b")).toThrow(/:/);
    expect(() => parseIdentifier("user: ")).toThrow();
    expect(() => parseIdentifier("user\t:alice")).toThrow();
  });

  it("tryParseIdentifier returns null instead of throwing", () => {
    expect(tryParseIdentifier("user:alice")).toEqual({ type: "user", id: "alice" });
    expect(tryParseIdentifier("garbage")).toBeNull();
  });

  it("isValidIdentifier narrows strings", () => {
    expect(isValidIdentifier("user:alice")).toBe(true);
    expect(isValidIdentifier("user:alice:again")).toBe(false);
  });

  it("frozen result cannot be mutated", () => {
    const parsed = parseIdentifier("user:alice");
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});
