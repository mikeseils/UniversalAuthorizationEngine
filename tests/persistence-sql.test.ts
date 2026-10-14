import { describe, expect, it, vi } from "vitest";
import { parseIdentifier } from "../packages/core/src/index.js";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  PersistenceError,
  PostgresPolicyStore,
  PostgresRelationshipStore,
  PostgresRelationshipWriter,
  StoreTimeoutError,
  StoreUnavailableError,
  attachPoolErrorHandler,
  buildQuery,
  getRelationshipVersion,
  handlePoolError,
  isPersistenceError,
  normalizeQueryResult,
  persistenceError,
  poolConfig,
  type PgQueryable,
  type PoolErrorSource,
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

/**
 * A pool-like test double for the `on("error", …)` wiring.
 *
 * The real thing cannot be asserted on without a driver, and the wiring is the
 * only barrier between a dropped idle client and an unhandled `error` event, so
 * it is tested through the narrow `PoolErrorSource` shape instead.
 */
function fakePoolSource(): {
  source: PoolErrorSource;
  emit: (error: unknown) => void;
  listenerCount: () => number;
} {
  const listeners: ((error: unknown) => void)[] = [];
  return {
    source: {
      on: (_event, listener) => {
        listeners.push(listener);
      },
    },
    emit: (error) => {
      for (const listener of listeners) listener(error);
    },
    listenerCount: () => listeners.length,
  };
}

describe("normalizeQueryResult", () => {
  it("passes a single result through unchanged", () => {
    const result = normalizeQueryResult<{ a: number }>({ rows: [{ a: 1 }], rowCount: 1 });
    expect(result).toEqual({ rows: [{ a: 1 }], rowCount: 1 });
  });

  it("unwraps the multi-statement array node-postgres returns for migrations", () => {
    // Live-Postgres regression: migration files contain several statements, so
    // the driver resolves to an ARRAY of results. Reading `.rows` off that
    // array is undefined and threw inside runMigrations, failing the whole
    // live suite before a single contract case ran. The recording double never
    // produced this shape — hence the miss, and hence a live database being
    // part of the Phase 6 definition of done.
    const raw = [
      { rows: [], rowCount: null },
      { rows: [], rowCount: null },
      { rows: [{ ok: true }], rowCount: 1 },
    ];
    const result = normalizeQueryResult<{ ok: boolean }>(raw);
    expect(result.rows).toEqual([{ ok: true }]);
    expect(result.rowCount).toBe(1);
  });

  it("falls back to rows.length when rowCount is null (DDL)", () => {
    expect(normalizeQueryResult({ rows: [], rowCount: null }).rowCount).toBe(0);
    expect(normalizeQueryResult([]).rowCount).toBe(0);
  });
});

describe("pool safety (never fatal, never silent)", () => {
  it("bounds connection and idle time by default, because pg waits forever", () => {
    const config = poolConfig({ connectionString: "postgres://unused/unused" });
    expect(config.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(config.idleTimeoutMillis).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    // No statement timeout unless asked for: bounding query work is a server
    // policy choice, not something a client library should impose silently.
    expect(config).not.toHaveProperty("statement_timeout");
  });

  it("lets explicit options win and forwards a statement timeout", () => {
    const config = poolConfig({
      connectionString: "postgres://unused/unused",
      max: 3,
      connectionTimeoutMillis: 250,
      idleTimeoutMillis: 1_000,
      statementTimeoutMillis: 2_000,
    });
    expect(config.max).toBe(3);
    expect(config.connectionTimeoutMillis).toBe(250);
    expect(config.idleTimeoutMillis).toBe(1_000);
    expect(config.statement_timeout).toBe(2_000);
  });

  it("classifies a lost connection as unavailable, not as a query failure", () => {
    // An idle client dropped by the server (ECONNRESET) is an outage by the
    // definition in errors.ts ("could not be reached or the connection was
    // lost"), so it must not be misreported as a bad query.
    const failure = handlePoolError(
      Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" }),
      () => undefined,
    );
    expect(isPersistenceError(failure)).toBe(true);
    expect(failure.reason).toBe("unavailable");
    // ADR-0020: unavailable is a *class*, not just a reason string, so callers
    // branch on `instanceof` and never string-match a log field.
    expect(failure).toBeInstanceOf(StoreUnavailableError);
  });

  it("reports pool errors to the sink exactly once", () => {
    const seen: PersistenceError[] = [];
    const returned = handlePoolError(new Error("network down"), (error) => seen.push(error));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(returned);
  });

  it("warns instead of throwing when no sink is configured", () => {
    // A pool-level error is not awaited by anyone, so it can never be thrown at
    // a caller. `process.emitWarning` keeps it visible without ending the
    // process — the alternative to a listener is a crash, not silence.
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => process);
    try {
      expect(() => handlePoolError(new Error("network down"))).not.toThrow();
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("passes an already-typed failure through unchanged", () => {
    const original = new PersistenceError("unavailable", "already classified");
    // A sink is supplied so the pass-through assertion does not emit a real
    // process warning as a side effect of testing — the default sink is
    // `process.emitWarning`, and a test that pollutes stderr with its own
    // fixture messages ("already classified") breaks CI log hygiene for no
    // coverage gain. The sink also pins the stronger contract: the caller's
    // handler still receives the *same* object, not a re-wrapped copy.
    const seen: PersistenceError[] = [];
    expect(handlePoolError(original, (error) => seen.push(error))).toBe(original);
    expect(seen).toEqual([original]);
  });

  it("attaches an error listener that routes pool errors to the sink", () => {
    const { source, emit, listenerCount } = fakePoolSource();
    const seen: PersistenceError[] = [];
    attachPoolErrorHandler(source, (error) => seen.push(error));
    expect(listenerCount()).toBe(1);
    emit(Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe("unavailable");
    expect(seen[0]).toBeInstanceOf(StoreUnavailableError);
  });
});

/**
 * Error taxonomy (ADR-0020).
 *
 * The classification is a *contract*, not an implementation detail: a caller
 * choosing between "retry later" and "page the on-call" must not have to read
 * driver error strings. Each row is asserted directly against the mapper.
 */
describe("error taxonomy (ADR-0020)", () => {
  const classify = (code: string, message = "boom") =>
    persistenceError("op", Object.assign(new Error(message), { code }));

  it("maps a missing table to schema_missing, not to a query failure", () => {
    const error = classify("42P01", 'relation "relationships" does not exist');
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).not.toBeInstanceOf(StoreUnavailableError);
    expect(error).not.toBeInstanceOf(StoreTimeoutError);
    expect(error.reason).toBe("schema_missing");
  });

  it("maps a server statement_timeout to StoreTimeoutError", () => {
    // 57014 is what PostgreSQL raises when `statement_timeout` fires. Treating
    // it as unavailability would page the network team for a slow query.
    const error = classify("57014", "canceling statement due to statement timeout");
    expect(error).toBeInstanceOf(StoreTimeoutError);
    expect(error).not.toBeInstanceOf(StoreUnavailableError);
    expect(error.reason).toBe("timeout");
  });

  it("maps a client connection timeout to StoreTimeoutError", () => {
    const error = classify("ETIMEDOUT", "Connection terminated");
    expect(error).toBeInstanceOf(StoreTimeoutError);
    expect(error.reason).toBe("timeout");
  });

  it("maps a dropped idle client to StoreUnavailableError", () => {
    // The real Phase 6 defect: node-postgres raises this on an *idle* client,
    // where nothing is awaiting it. It must be typed, not a bare Error.
    const error = classify("ECONNRESET", "Connection terminated unexpectedly");
    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect(error).not.toBeInstanceOf(StoreTimeoutError);
    expect(error.reason).toBe("unavailable");
  });

  it("maps SQLSTATE 08xxx connection exceptions to StoreUnavailableError", () => {
    for (const code of ["08000", "08001", "08003", "08006"]) {
      expect(classify(code).reason).toBe("unavailable");
    }
  });

  it("maps a constraint violation to a plain query_failed", () => {
    // A violated constraint is a bug in the caller, not an outage: retrying
    // will fail identically, so it must not be dressed as unavailability.
    const error = classify("23505", "duplicate key value violates unique constraint");
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).not.toBeInstanceOf(StoreUnavailableError);
    expect(error).not.toBeInstanceOf(StoreTimeoutError);
    expect(error.reason).toBe("query_failed");
  });

  it("keeps the driver error as the cause and never leaks it as the reason", () => {
    const driver = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const error = persistenceError("getRelationships", driver);
    expect(error.cause).toBe(driver);
    expect(error.message).toContain("getRelationships failed");
    // The message carries the operation, not a secret: a connection string with
    // credentials is never part of the typed error's own fields.
    expect(error.reason).toBe("unavailable");
  });

  it("is idempotent: reclassifying a typed error returns it unchanged", () => {
    const original = new StoreTimeoutError("already classified");
    expect(persistenceError("op", original)).toBe(original);
  });
});

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
    expect(
      calls.some((call) =>
        call.sql.includes("ON CONFLICT ON CONSTRAINT relationships_pkey DO NOTHING"),
      ),
    ).toBe(true);
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

  it("bumps the relationship-state version only when a row actually changes", async () => {
    const edge = {
      subject: "user:alice",
      relation: "admin",
      resource: "project:alpha",
    };

    // A real insert yields a RETURNING row, so the writer bumps.
    const inserted = recordingDb([{}]);
    await new PostgresRelationshipWriter(inserted.db).add(edge);
    expect(inserted.calls.some((call) => call.sql.includes("relationship_state_version"))).toBe(
      true,
    );

    // A retried add of the same edge yields no RETURNING row, so the writer
    // must not bump. Retries are the common case for idempotent writes; bumping
    // on them would evict the whole decision cache on ordinary traffic.
    const retried = recordingDb([]);
    await new PostgresRelationshipWriter(retried.db).add(edge);
    expect(retried.calls.some((call) => call.sql.includes("relationship_state_version"))).toBe(
      false,
    );

    // A delete that removed a row bumps; a delete of nothing does not.
    const removed = recordingDb([{}]);
    await new PostgresRelationshipWriter(removed.db).remove(edge);
    expect(removed.calls.some((call) => call.sql.includes("relationship_state_version"))).toBe(
      true,
    );
    const absent = recordingDb([]);
    await new PostgresRelationshipWriter(absent.db).remove(edge);
    expect(absent.calls.some((call) => call.sql.includes("relationship_state_version"))).toBe(
      false,
    );
  });

  it("holds every write and its bump inside one transaction", async () => {
    // A row committed at the old version — or a bump committed without its
    // row — is a phantom window a version-keyed cache cannot see. BEGIN must
    // come first and COMMIT last for add, remove, and addBatch alike.
    const edge = {
      subject: "user:alice",
      relation: "admin",
      resource: "project:alpha",
    };
    for (const run of [
      (db: PgQueryable) => new PostgresRelationshipWriter(db).add(edge),
      (db: PgQueryable) => new PostgresRelationshipWriter(db).remove(edge),
      (db: PgQueryable) => new PostgresRelationshipWriter(db).addBatch([edge]),
    ]) {
      const { db, calls } = recordingDb([{}]);
      await run(db);
      expect(calls[0]?.sql).toContain("BEGIN");
      expect(calls[calls.length - 1]?.sql).toContain("COMMIT");
      const bumpIndex = calls.findIndex((call) => call.sql.includes("relationship_state_version"));
      expect(bumpIndex).toBeGreaterThan(0);
      expect(bumpIndex).toBeLessThan(calls.length - 1);
    }
  });

  it("bumps once per batch, inside the same transaction as the rows", async () => {
    const { db, calls } = recordingDb([{}, {}]);
    await new PostgresRelationshipWriter(db).addBatch([
      { subject: "user:a", relation: "member", resource: "group:g" },
      { subject: "user:b", relation: "member", resource: "group:g" },
    ]);
    const bumps = calls.filter((call) => call.sql.includes("relationship_state_version"));
    expect(bumps).toHaveLength(1);
    // BEGIN … COMMIT must bracket both the inserts and the bump, or a crash
    // between them would leave new rows at the old version.
    expect(calls[0]?.sql).toContain("BEGIN");
    expect(calls[calls.length - 1]?.sql).toContain("COMMIT");
  });

  it("reads the relationship-state version without consuming it", async () => {
    const { db, calls } = recordingDb([{ version: "42" }]);
    expect(await getRelationshipVersion(db)).toBe("42");
    expect(await getRelationshipVersion(db)).toBe("42");
    // The read must be side-effect free: consuming a sequence value on every
    // read would advance the version just by observing it, invalidating the
    // cache entry the observation was building a key for.
    expect(calls.every((call) => !call.sql.includes("nextval"))).toBe(true);
    expect(calls[0]?.sql).toContain("relationship_state_version");
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

  it("refuses to activate a version with an invalid identifier shape", async () => {
    const { db, calls } = recordingDb();
    // Shape-invalid input rejects without a DB lookup; well-formed-but-unknown
    // ("999") performs exactly one lookup then rejects before any write.
    await expect(
      new PostgresPolicyStore(db).setActiveVersion("'; DROP TABLE policies"),
    ).rejects.toThrow();
    await expect(new PostgresPolicyStore(db).setActiveVersion("999")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("reset clears policy state and restarts the version sequence", async () => {
    const { db, calls } = recordingDb();
    await new PostgresPolicyStore(db).reset();
    // `TRUNCATE ... RESTART IDENTITY` restarts only sequences *owned* by the
    // truncated tables, and `policy_versions` is standalone, so the restart is
    // a second statement. Without it a reset store is not indistinguishable
    // from a freshly migrated one (versions keep climbing across resets).
    expect(calls.map((call) => call.sql)).toEqual([
      "TRUNCATE policy_deployments, policies RESTART IDENTITY",
      "ALTER SEQUENCE policy_versions RESTART WITH 1",
    ]);
  });
});
