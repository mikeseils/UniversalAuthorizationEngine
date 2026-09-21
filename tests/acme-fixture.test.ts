import { describe, expect, it } from "vitest";
import { parseIdentifier } from "../packages/core/src/index.js";
import { ACME_RELATIONSHIPS, parseFixtureLine } from "../examples/acme/fixture.js";

/**
 * Canonical domain fixture (docs/design/domain-model.md). Every line must be
 * well-formed: if the canonical example ever becomes malformed, everything
 * built on it (docs, tests, examples) is suspect.
 */
describe("canonical Acme fixture", () => {
  it("contains the documented relationships", () => {
    expect(ACME_RELATIONSHIPS).toHaveLength(7);
  });

  it("every fixture line parses into a valid relationship", () => {
    for (const line of ACME_RELATIONSHIPS) {
      const { subject, relation, resource } = parseFixtureLine(line);
      expect(() => parseIdentifier(subject)).not.toThrow();
      expect(() => parseIdentifier(resource)).not.toThrow();
      expect(relation).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("covers RBAC, ReBAC, ownership, and containment edges", () => {
    const relations = new Set(ACME_RELATIONSHIPS.map((line) => parseFixtureLine(line).relation));
    expect(relations).toEqual(new Set(["admin", "member", "owns", "owner", "viewer", "contains"]));
  });
});
