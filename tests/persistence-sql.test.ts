import { describe, expect, it } from "vitest";
import { parseIdentifier } from "../packages/core/src/index.js";
import {
  PersistenceError,
  PostgresPolicyStore,
  PostgresRelationshipStore,
  PostgresRelationshipWriter,
  buildQuery,
  isPersistenceError,
} from "../packages/persistence/src/index.js";
import { failingDb, recordingDb } from "./persistence-double.js";

/**
 * Postgres store behaviour that does **not** need a live database.
 *
 * These cover the security-relevant properties: identifiers are never
 * interpolated into SQL, a driver failure is a typed infrastructure error
 * rather than an empty result, and malformed input never reaches the database.
 */

const SUBJECT = parseIdentifier("user:alice");
const PROJECT = parseIdentifier("project:alpha");

describe("buildQuery", () => {
  it("emits no WHERE clause for an unbound query", () => {
    const { sql, values } = buildQuery({});
    expect(sql).not.toContain("WHERE");
    expect(values).toHaveLength(0);
    // Deterministic ordering is required by ADR-0018 S3.
    expect(sql).toContain("ORDER BY subject_type, subject_id, relation");
  });

  it("binds a fully-specified query in order", () => {
    const { sql, values } = buildQuery({ subject: SUBJECT, relation: "admin", resource: PROJECT });
    expect(values).toEqual(["user", "alice", "admin", "project", "alpha"]);
    expect(sql).toContain("subject_type = $1");
    expect(sql).toContain("relation = $3");
    expect(sql).toContain("resource_type = $4");
  });

  it("omits predicates for unbound positions", () => {
    const { sql, values } = buildQuery({ resource: PROJECT, relation: "contains" });
    expect(values).toEqual(["contains", "project", "alpha"]);
    expect(sql).not.toContain("subject_type =");
  });

  it("never interpolates identifier values into SQL text", () => {
    // The core identifier grammar (`packages/core/src/identifiers.ts`) already
    // rejects SQL metacharacters, spaces, and colons, so a hostile id cannot
    // even be constructed. Parameterization is the second line of defence;
    // this test pins the first.
    const hostile = "'; DROP TABLE relationships; --";
    expect(() => parseIdentifier(`user:${hostile}`)).toThrow();
    const { sql, values } = buildQuery({ subject: parseIdentifier("user:alice-smith_1") });
    expect(sql).not.toContain("alice");
    expect(values).toContain("alice-smith_1");
  });
});

describe("PostgresRelationshipStore", () => {
  it("reads inside a REPEATABLE READ snapshot (ADR-0018 S2)", async () => {
    const { db, calls } = recordingDb();
    await new PostgresRelationshipStore(db).getRelationships({ subject: SUBJECT });
    expect(calls.some((c) => c.sql.includes("BEGIN ISOLATION LEVEL REPEATABLE READ"))).toBe(true);
  });

  it("maps rows to frozen relationships", async () => {
    const { db } = recordingDb([
      {
        subject_type: "user",
        subject_id: "alice",
        relation: "admin",
        resource_type: "project",
        resource_id: "alpha",
      },
    ]);
    const rows = await new PostgresRelationshipStore(db).getRelationships({ subject: SUBJECT });
    expect(rows).toHaveLength(1);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(rows[0]?.subject).toEqual({ type: "user", id: "alice" });
  });

  it("maps a driver failure to a typed error instead of an empty result", async () => {
    const db = failingDb("ECONNREFUSED", "connection terminated");
    // Critically this must THROW. Returning [] would turn an outage into a
    // silent universal denial and erase the DENIED-vs-UNAVAILABLE distinction.
    await expect(new PostgresRelationshipStore(db).getRelationships({})).rejects.toThrow(
      PersistenceError,
    );
  });

  it("classifies a missing table as a schema error", async () => {
    const db = failingDb("42P01", 'relation "relationships" does not exist');
    const error = await new PostgresRelationshipStore(db)
      .getRelationships({})
      .catch((e: unknown) => e);
    expect(isPersistenceError(error)).toBe(true);
    expect((error as PersistenceError).reason).toBe("schema_missing");
  });

  it("classifies a refused connection as unavailable", async () => {
    const error = await new PostgresRelationshipStore(failingDb("ECONNREFUSED", "nope"))
      .getRelationships({})
      .catch((e: unknown) => e);
    expect((error as PersistenceError).reason).toBe("unavailable");
  });

  it("rejects a malformed query at the boundary without touching the database", async () => {
    const { db, calls } = recordingDb();
    await expect(
      new PostgresRelationshipStore(db).getRelationships({
        subject: { type: "user" } as never,
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("PostgresRelationshipWriter", () => {
  it("uses ON CONFLICT DO NOTHING so retries cannot duplicate (ADR-0018 S5)", async () => {
    const { db, calls } = recordingDb();
    await new PostgresRelationshipWriter(db).add({
      subject: "user:alice",
      relation: "admin",
      resource: "project:alpha",
    });
    expect(calls[0]?.sql).toContain("ON CONFLICT ON CONSTRAINT relationships_pkey DO NOTHING");
  });

  it("rejects malformed relationships before issuing SQL", async () => {
    const { db, calls } = recordingDb();
    await expect(
      new PostgresRelationshipWriter(db).add({ subject: "nope", relation: "x", resource: "y" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("reports whether a delete removed a row", async () => {
    // A delete affecting one row reports rowCount 1; the sentinel row stands in
    // for "the driver reported a match".
    const removed = recordingDb([{}]);
    expect(
      await new PostgresRelationshipWriter(removed.db).remove({
        subject: "user:alice",
        relation: "admin",
        resource: "project:alpha",
      }),
    ).toBe(true);
    const absent = recordingDb();
    expect(
      await new PostgresRelationshipWriter(absent.db).remove({
        subject: "user:alice",
        relation: "admin",
        resource: "project:alpha",
      }),
    ).toBe(false);
  });
});

describe("PostgresPolicyStore", () => {
  it("throws rather than returning a policy when nothing is active", async () => {
    const { db } = recordingDb();
    // A missing active pointer must be loud, not an implicit "no policy" deny.
    await expect(new PostgresPolicyStore(db).getActivePolicy()).rejects.toThrow();
  });

  it("returns null for an unknown version", async () => {
    const { db } = recordingDb();
    expect(await new PostgresPolicyStore(db).getPolicyVersion("nope")).toBeNull();
  });

  it("refuses to activate a version with an invalid identifier shape", () => {
    const { db } = recordingDb();
    expect(() => {
      new PostgresPolicyStore(db).setActiveVersion("'; DROP TABLE policies");
    }).toThrow();
  });
});
