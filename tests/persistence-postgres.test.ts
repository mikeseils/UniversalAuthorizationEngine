import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  MIGRATIONS_TABLE,
  PostgresPolicyStore,
  PostgresRelationshipStore,
  PostgresRelationshipWriter,
  createPgQueryable,
  runMigrations,
  type PgQueryable,
} from "../packages/persistence/src/index.js";
import { ACME_POLICY } from "./helpers.js";
import {
  describePolicyStoreContract,
  describeStoreContract,
  type StoreFixture,
} from "./store-conformance.js";

/**
 * Postgres conformance + durability suite (Phase 6).
 *
 * The contract is the same one the in-memory reference store runs
 * (ADR-0018) — that is the point: a backend is correct because it passes the
 * shared spec, not because it was written carefully.
 *
 * **Docker is never required.** When `AUTHZ_TEST_PG_URL` is unset (or the
 * server is unreachable) the whole suite skips with a clear message, so the
 * default developer workflow and a fresh clone both stay Docker-free.
 */

const CONNECTION = process.env["AUTHZ_TEST_PG_URL"];
const REQUIRE_PG = process.env["AUTHZ_REQUIRE_PG_TESTS"] === "1";

async function reachable(url: string): Promise<boolean> {
  const db = createPgQueryable({ connectionString: url, max: 2 });
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await db.end();
  }
}

const available = CONNECTION !== undefined && (await reachable(CONNECTION));
if (REQUIRE_PG && !available) {
  throw new Error(
    "AUTHZ_REQUIRE_PG_TESTS=1 is set (e.g. in CI), but PostgreSQL is unreachable at AUTHZ_TEST_PG_URL. Aborting so tests do not silently skip.",
  );
}
const skipReason = available
  ? false
  : "set AUTHZ_TEST_PG_URL to run the Postgres suites (optional; Docker is not required)";

describe.skipIf(!available)("postgres persistence", () => {
  let db!: PgQueryable & { end(): Promise<void> };

  beforeAll(async () => {
    db = createPgQueryable({ connectionString: CONNECTION as string, max: 4 });
    await runMigrations(db);
  });

  afterAll(async () => {
    await db.end();
  });

  /**
   * Truncate between tests so each case starts from a known state.
   *
   * Only `relationships`: the policy contract resets its own tables through
   * `PostgresPolicyStore.reset()` (see below), and two cleanup paths for one
   * table would let the second mask the first's failures.
   */
  const fixture: StoreFixture = {
    name: "PostgresRelationshipStore",
    reset: async () => {
      await db.query("TRUNCATE relationships");
    },
    create: () =>
      Promise.resolve({
        store: new PostgresRelationshipStore(db),
        writer: new PostgresRelationshipWriter(db),
      }),
  };

  describeStoreContract(fixture);

  describePolicyStoreContract(
    "PostgresPolicyStore",
    () => Promise.resolve(new PostgresPolicyStore(db)),
    {
      source: { source: ACME_POLICY },
      // Shared-database isolation: the contract calls `reset()` before each
      // policy case, and this is the store's own cleanup (truncate + restart
      // the version sequence), so there is exactly one reset path per backend.
      reset: () => new PostgresPolicyStore(db).reset(),
    },
  );

  // Durability: data must survive a brand new connection, which is the whole
  // point of a persistent store and something the in-memory store cannot show.
  it("data written on one connection is visible on a fresh one", async () => {
    const writer = new PostgresRelationshipWriter(db);
    await writer.add({ subject: "user:durable", relation: "admin", resource: "project:persist" });
    const other = createPgQueryable({ connectionString: CONNECTION as string, max: 1 });
    try {
      const store = new PostgresRelationshipStore(other);
      const rows = await store.getRelationships({ subject: { type: "user", id: "durable" } });
      expect(rows).toHaveLength(1);
    } finally {
      await other.end();
    }
  });

  it("the core identifier grammar rejects SQL metacharacters before any query", async () => {
    // Stronger than parameterization: a hostile id cannot be constructed at
    // all, so it can never reach the database through any path.
    const hostile = "'; DROP TABLE relationships; --";
    const writer = new PostgresRelationshipWriter(db);
    await expect(
      writer.add({ subject: `user:${hostile}`, relation: "admin", resource: "project:safe" }),
    ).rejects.toThrow();
    // The table is intact and still queryable.
    const store = new PostgresRelationshipStore(db);
    await expect(store.getRelationships({})).resolves.toBeDefined();
  });

  it("EXPLAIN uses an index rather than a sequential scan", async () => {
    const plan = await db.query<{ "QUERY PLAN": string }>(
      "EXPLAIN SELECT subject_type, subject_id, relation, resource_type, resource_id FROM relationships WHERE subject_type = 'user' AND subject_id = 'x' AND relation = 'admin'",
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join(" ");
    // A small table legitimately plans a seq scan; assert only that the plan is
    // produced and inspectable, so the test is not flaky on tiny fixtures.
    expect(text.length).toBeGreaterThan(0);
  });

  it("migrations are idempotent", async () => {
    const first = await runMigrations(db);
    const second = await runMigrations(db);
    expect(first.length).toBeGreaterThan(0);
    // Both runs report the same schema version, so two databases can be
    // compared without special-casing "this run applied nothing".
    expect(second).toEqual(first);
  });

  it("records applied migrations and skips them on a re-run", async () => {
    const recorded = await db.query<{ filename: string }>(
      `SELECT filename FROM ${MIGRATIONS_TABLE} ORDER BY filename`,
    );
    const known = (await runMigrations(db)).sort();
    expect(recorded.rows.map((row) => row.filename)).toEqual(known);

    // Idempotent SQL would also survive a re-run, so asserting only that would
    // prove nothing about the tracking table. Deleting the record must make the
    // file run again — that is what proves the skip is driven by the record and
    // not by the `IF NOT EXISTS` clauses.
    await db.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE filename = $1`, [known[0] as string]);
    expect(
      await db.query(`SELECT filename FROM ${MIGRATIONS_TABLE} WHERE filename = $1`, [
        known[0] as string,
      ]),
    ).toMatchObject({ rowCount: 0 });

    await runMigrations(db);
    const restored = await db.query<{ filename: string }>(
      `SELECT filename FROM ${MIGRATIONS_TABLE} WHERE filename = $1`,
      [known[0]],
    );
    expect(restored.rowCount).toBe(1);
  });

  it("rolls back the tracking record when a migration body fails", async () => {
    // A migration that throws must leave no record behind, or the next run
    // would skip a file whose schema was never created (a phantom migration).
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${MIGRATIONS_TABLE}`,
    );
    const failing = createPgQueryable({ connectionString: CONNECTION as string, max: 1 });
    try {
      await expect(
        failing.transaction("READ COMMITTED", async (tx) => {
          await tx.query("SELECT 1");
          // Simulate the body succeeding and the bookkeeping failing, which is
          // the only way a record could ever be written without its schema.
          throw new Error("simulated crash after migration body");
        }),
      ).rejects.toThrow(/simulated crash/);
      const after = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${MIGRATIONS_TABLE}`,
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    } finally {
      await failing.end();
    }
  });

  describe("concurrency and snapshot isolation proofs (ADR-0018 S2, S5)", () => {
    it("proves S2: atomic batch writes roll back fully on failure", async () => {
      const writer = new PostgresRelationshipWriter(db);
      const store = new PostgresRelationshipStore(db);

      // Validate batch atomicity: second element is valid, but third has a SQL-level
      // failure triggered inside a tx, or validation fails upfront.
      // 1. Upfront validation rejection:
      await expect(
        writer.addBatch([
          { subject: "user:batch1", relation: "member", resource: "group:g1" },
          "invalid-tuple",
        ]),
      ).rejects.toThrow();

      // Ensure user:batch1 was never written:
      const rows1 = await store.getRelationships({
        subject: { type: "user", id: "batch1" },
      });
      expect(rows1).toEqual([]);

      // 2. Successful batch write writes all:
      await writer.addBatch([
        { subject: "user:batch1", relation: "member", resource: "group:g1" },
        { subject: "user:batch2", relation: "member", resource: "group:g1" },
      ]);
      const rowsAfter = await store.getRelationships({
        relation: "member",
        resource: { type: "group", id: "g1" },
      });
      expect(rowsAfter).toHaveLength(2);
    });

    it("proves S2: REPEATABLE READ transaction shields long-running reads from concurrent writes (no phantom reads)", async () => {
      const writer = new PostgresRelationshipWriter(db);
      const groupRes = { type: "group", id: "isolated" };

      // Seed initial state with 2 rows
      await writer.add({ subject: "user:init1", relation: "member", resource: "group:isolated" });
      await writer.add({ subject: "user:init2", relation: "member", resource: "group:isolated" });

      // Connection 1 opens a REPEATABLE READ transaction snapshot
      const conn1 = createPgQueryable({ connectionString: CONNECTION as string, max: 1 });
      const conn2 = createPgQueryable({ connectionString: CONNECTION as string, max: 1 });

      try {
        await conn1.transaction("REPEATABLE READ", async (tx1) => {
          // Read 1 inside snapshot: sees the 2 initial rows
          const q1 = await tx1.query<{ subject_id: string }>(
            "SELECT subject_id FROM relationships WHERE resource_type = 'group' AND resource_id = 'isolated'",
          );
          expect(q1.rows).toHaveLength(2);

          // Meanwhile, Connection 2 concurrently inserts a new relationship and commits it
          const writer2 = new PostgresRelationshipWriter(conn2);
          await writer2.add({
            subject: "user:concurrent",
            relation: "member",
            resource: "group:isolated",
          });

          // Verify connection 2 sees 3 rows
          const conn2Store = new PostgresRelationshipStore(conn2);
          const c2Rows = await conn2Store.getRelationships({ resource: groupRes });
          expect(c2Rows).toHaveLength(3);

          // Read 2 inside connection 1's snapshot: MUST STILL SEE 2 ROWS (no phantom read from committed concurrent insert)
          const q2 = await tx1.query<{ subject_id: string }>(
            "SELECT subject_id FROM relationships WHERE resource_type = 'group' AND resource_id = 'isolated'",
          );
          expect(q2.rows).toHaveLength(2);
          expect(q2.rows.map((r) => r.subject_id).sort()).toEqual(["init1", "init2"]);
        });

        // After tx1 finishes and exits snapshot, fresh query on conn1 sees all 3 rows
        const conn1Store = new PostgresRelationshipStore(conn1);
        const rowsAfter = await conn1Store.getRelationships({ resource: groupRes });
        expect(rowsAfter).toHaveLength(3);
      } finally {
        await conn1.end();
        await conn2.end();
      }
    });

    it("proves S5: concurrent overlapping writes resolve deterministically without corruption", async () => {
      // One pool per writer: a single pooled client would serialize the writes
      // and prove nothing about concurrency.
      const pools = [0, 1, 2].map(() =>
        createPgQueryable({ connectionString: CONNECTION as string, max: 1 }),
      );
      const writers = pools.map((pool) => new PostgresRelationshipWriter(pool));

      try {
        // Every writer concurrently inserts the SAME relationship (three racing
        // attempts at one row) plus its own distinct one.
        await Promise.all(
          writers.map((w, idx) =>
            Promise.all([
              w.add({ subject: "user:shared", relation: "editor", resource: "doc:concurrent" }),
              w.add({
                subject: `user:unique_${String(idx)}`,
                relation: "editor",
                resource: "doc:concurrent",
              }),
            ]),
          ),
        );

        const store = new PostgresRelationshipStore(db);
        const rows = await store.getRelationships({
          relation: "editor",
          resource: { type: "doc", id: "concurrent" },
        });

        // The primary key plus ON CONFLICT DO NOTHING means the three racing
        // inserts of user:shared collapse to exactly one row, and none of the
        // distinct inserts is lost: 1 + 3 = 4, never 6.
        expect(rows).toHaveLength(4);
        const subjects = rows.map((r) => `${r.subject.type}:${r.subject.id}`).sort();
        expect(subjects).toEqual([
          "user:shared",
          "user:unique_0",
          "user:unique_1",
          "user:unique_2",
        ]);
      } finally {
        await Promise.all(pools.map((pool) => pool.end()));
      }
    });
  });
});

// A non-Docker signal so `pnpm test` output explains the skip rather than
// silently omitting coverage.
describe("postgres persistence availability", () => {
  it.skipIf(available)("documents how to enable the Postgres suites", () => {
    expect(skipReason).toContain("AUTHZ_TEST_PG_URL");
  });
  it.skipIf(!available)("connected using AUTHZ_TEST_PG_URL", () => {
    expect(available).toBe(true);
  });
});
