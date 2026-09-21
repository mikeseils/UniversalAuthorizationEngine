import { describe, expect, it } from "vitest";
import {
  isValidAction,
  parseAction,
  parseResource,
  parseSubject,
  ValidationError,
} from "../packages/core/src/index.js";

describe("parseSubject / parseResource", () => {
  it("parses subjects and resources through the identifier rules", () => {
    expect(parseSubject("user:alice")).toEqual({ type: "user", id: "alice" });
    expect(parseSubject("agent:support-42")).toEqual({
      type: "agent",
      id: "support-42",
    });
    expect(parseResource("document:456")).toEqual({
      type: "document",
      id: "456",
    });
  });

  it("rejects malformed principals", () => {
    expect(() => parseSubject("alice")).toThrow(ValidationError);
    expect(() => parseResource("document:")).toThrow(ValidationError);
  });
});

describe("parseAction", () => {
  it.each(["read", "document.read", "project.write", "invoice.approve"])("accepts %s", (action) => {
    expect(parseAction(action)).toBe(action);
  });

  it.each([
    "",
    "Read",
    "document..read",
    ".read",
    "read.",
    "document read",
    "document-READ",
    "delete!",
    7,
    null,
    undefined,
  ])("rejects %s", (input) => {
    expect(() => parseAction(input)).toThrow(ValidationError);
  });

  it("isValidAction guards without throwing", () => {
    expect(isValidAction("document.read")).toBe(true);
    expect(isValidAction("BAD")).toBe(false);
  });
});
