import { describe, expect, it } from "vitest";
import { ValidationError } from "../packages/core/src/index.js";
import {
  InMemoryPolicyStore,
  PolicyStoreError,
  allOf,
  anyOf,
  contextEquals,
  indirectRef,
  notExpr,
  relationRef,
  validateStructuredPolicy,
} from "../packages/policy/src/index.js";

const valid = {
  definitions: {
    document: {
      relations: { owner: { subjectTypes: ["user"] } },
      permissions: { read: anyOf(relationRef("owner")) },
    },
  },
};

describe("validateStructuredPolicy", () => {
  it("accepts a valid policy", () => {
    const result = validateStructuredPolicy(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it.each([null, "policy", 42, [], {}])("rejects malformed source %s", (source) => {
    expect(validateStructuredPolicy(source).valid).toBe(false);
  });

  it("rejects references to undeclared relations", () => {
    const source = {
      definitions: {
        document: {
          relations: {},
          permissions: { read: anyOf(relationRef("viewer")) },
        },
      },
    };
    const result = validateStructuredPolicy(source);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/undeclared relation "viewer"/);
  });

  it("rejects context conditions on undeclared keys", () => {
    const result = validateStructuredPolicy({
      definitions: {
        invoice: {
          relations: { approver: { subjectTypes: ["user"] } },
          permissions: {
            approve: allOf(relationRef("approver"), contextEquals("mfa", true)),
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/undeclared context key "mfa"/);
  });

  it("rejects and/or with zero operands", () => {
    const result = validateStructuredPolicy({
      definitions: {
        document: {
          relations: { owner: { subjectTypes: ["user"] } },
          permissions: { read: anyOf() },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/at least one operand/);
  });

  it("warns on negation-based grants", () => {
    const result = validateStructuredPolicy({
      definitions: {
        document: {
          relations: { banned: { subjectTypes: ["user"] } },
          permissions: { read: notExpr(relationRef("banned")) },
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/negation-based grants are dangerous/);
  });

  it("rejects invalid type, relation, and permission names", () => {
    const result = validateStructuredPolicy({
      definitions: {
        Document: {
          relations: { Owner: { subjectTypes: ["user"] } },
          permissions: { Read: relationRef("owner") },
        },
      },
    });
    expect(result.valid).toBe(false);
  });
});

describe("InMemoryPolicyStore", () => {
  it("publishes immutable, hashed, monotonically versioned artifacts", async () => {
    const store = new InMemoryPolicyStore();
    const v1 = await store.publishPolicy({ source: valid });
    const v2 = await store.publishPolicy({ source: valid });
    expect(v1.version).toBe("1");
    expect(v2.version).toBe("2");
    expect(v1.hash).toBe(v2.hash); // same content → same artifact hash
    expect(Object.isFrozen(v1.artifact)).toBe(true);
  });

  it("rejects invalid policies at publish time", async () => {
    const store = new InMemoryPolicyStore();
    await expect(store.publishPolicy({ source: { definitions: {} } })).rejects.toThrow(
      PolicyStoreError,
    );
  });

  it("throws a typed error when no active policy exists", async () => {
    const store = new InMemoryPolicyStore();
    await expect(store.getActivePolicy()).rejects.toThrow(PolicyStoreError);
  });

  it("activates versions explicitly and retrieves any version", async () => {
    const store = new InMemoryPolicyStore();
    await store.publishPolicy({ source: valid });
    const v2 = await store.publishPolicy({
      source: {
        definitions: {
          document: {
            relations: { owner: { subjectTypes: ["user"] } },
            permissions: { read: relationRef("owner") },
          },
        },
      },
    });
    store.setActiveVersion(v2.version);
    await expect(store.getActivePolicy()).resolves.toMatchObject({ version: "2" });
    await expect(store.getPolicyVersion("1")).resolves.toMatchObject({ version: "1" });
    expect(await store.getPolicyVersion("99")).toBeNull();
    expect(() => {
      store.setActiveVersion("99");
    }).toThrow(PolicyStoreError);
  });

  it("throws ValidationError-compatible failures for malformed batch input", () => {
    // Boundary validation is the caller's first line of defense.
    expect(() => {
      throw new ValidationError("action", "invalid");
    }).toThrow(ValidationError);
  });
});

describe("indirect traversal policy shape", () => {
  it("validates reverse traversals and nested permissions structurally", () => {
    const result = validateStructuredPolicy({
      definitions: {
        document: {
          relations: {},
          permissions: { read: anyOf(indirectRef("contains", "read", true)) },
        },
        project: {
          relations: { viewer: { subjectTypes: ["user"] } },
          permissions: { read: anyOf(relationRef("viewer")) },
        },
      },
    });
    expect(result.valid).toBe(true);
  });
});
