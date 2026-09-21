import { describe, expect, it } from "vitest";
import {
  parseRelationship,
  tryParseRelationship,
  ValidationError,
} from "../packages/core/src/index.js";

describe("parseRelationship", () => {
  it("accepts string refs", () => {
    const rel = parseRelationship({
      subject: "user:alice",
      relation: "member",
      resource: "organization:acme",
    });
    expect(rel).toEqual({
      subject: { type: "user", id: "alice" },
      relation: "member",
      resource: { type: "organization", id: "acme" },
    });
  });

  it("accepts structured refs", () => {
    const rel = parseRelationship({
      subject: { type: "user", id: "alice" },
      relation: "editor",
      resource: { type: "project", id: "123" },
    });
    expect(rel.subject).toEqual({ type: "user", id: "alice" });
  });

  it.each([
    null,
    "user:alice|member|organization:acme",
    { subject: "alice", relation: "member", resource: "organization:acme" },
    { subject: "user:alice", relation: "Member", resource: "organization:acme" },
    { subject: "user:alice", relation: "", resource: "organization:acme" },
    { subject: "user:alice", relation: "member" },
    { subject: "user:alice", relation: "member", resource: 3 },
  ])("rejects %s", (input) => {
    expect(() => parseRelationship(input)).toThrow(ValidationError);
  });

  it("tryParseRelationship returns null on malformed input", () => {
    expect(
      tryParseRelationship({
        subject: "user:alice",
        relation: "member",
        resource: "organization:acme",
      }),
    ).not.toBeNull();
    expect(tryParseRelationship("nonsense")).toBeNull();
  });

  it("result is frozen", () => {
    const rel = parseRelationship({
      subject: "user:alice",
      relation: "member",
      resource: "organization:acme",
    });
    expect(Object.isFrozen(rel)).toBe(true);
  });
});
