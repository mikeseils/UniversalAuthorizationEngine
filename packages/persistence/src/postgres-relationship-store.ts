import {
  Relationship,
  RelationshipQuery,
  ValidationError,
  VersionedRelationshipStore,
  parseRelationship,
} from "@uae/core";
import { persistenceError } from "./errors.js";
import { PgQueryExecutor, PgQueryable } from "./pool.js";

/**
 * PostgreSQL `RelationshipStore` (Phase 6, ADR-0017).
 *
 * Query construction is **static**: the SQL is fixed and bound positions are
 * parameterized. User-supplied identifiers are never interpolated into SQL
 * text, so a relationship id can never become SQL. Unbound query fields are
 * omitted from the `WHERE` clause, which is what makes "unbound means all"
 * (ADR-0018 S1) true by construction rather than by careful branching.
 *
 * Ordering is explicit (`ORDER BY` on the full primary key) because ADR-0018 S3
 * requires deterministic row order and explanations embed relationship order.
 */
export class PostgresRelationshipStore implements VersionedRelationshipStore {
  private readonly db: PgQueryable;

  constructor(db: PgQueryable) {
    this.db = db;
  }

  /**
   * Opaque state token (ADR-0018 S11): the `relationship_state_version`
   * sequence value. Side-effect free — observes via `last_value`, never
   * `nextval`, so building a cache key cannot invalidate the entry it keys.
   */
  async getRelationshipVersion(): Promise<string> {
    return getRelationshipVersion(this.db);
  }

  /**
   * Read matching relationships.
   *
   * Runs in a `REPEATABLE READ` transaction so that a traversal spanning
   * several reads observes one snapshot (ADR-0018 S2) — a concurrent write
   * cannot make a single decision mix pre- and post-mutation state.
   */
  async getRelationships(query: RelationshipQuery): Promise<readonly Relationship[]> {
    // Validate the shape up front: a malformed query is a caller error, not a
    // database error, and must never reach the driver.
    if (query.subject !== undefined) assertIdentifierRef(query.subject, "query.subject");
    if (query.resource !== undefined) assertIdentifierRef(query.resource, "query.resource");
    if (query.relation !== undefined && !/^[a-z][a-z0-9_]*$/.test(query.relation)) {
      throw new ValidationError("query.relation", `invalid relation "${query.relation}"`);
    }

    return this.db.transaction("REPEATABLE READ", async (tx) => {
      try {
        const { sql, values } = buildQuery(query);
        const result = await tx.query<RelationshipRow>(sql, values);
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              subject: Object.freeze({ type: row.subject_type, id: row.subject_id }),
              relation: row.relation,
              resource: Object.freeze({ type: row.resource_type, id: row.resource_id }),
            }),
          ),
        );
      } catch (error) {
        throw persistenceError("getRelationships", error);
      }
    });
  }
}

interface RelationshipRow {
  readonly subject_type: string;
  readonly subject_id: string;
  readonly relation: string;
  readonly resource_type: string;
  readonly resource_id: string;
}

/**
 * Build the SELECT for a query. Bound fields append a predicate and a
 * parameter; unbound fields contribute nothing, which is exactly the
 * "match all" semantics the core interface specifies.
 */
export function buildQuery(query: RelationshipQuery): {
  readonly sql: string;
  readonly values: readonly unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (query.subject !== undefined) {
    clauses.push("subject_type = $1", "subject_id = $2");
    values.push(query.subject.type, query.subject.id);
  }
  if (query.relation !== undefined) {
    clauses.push(`relation = $${String(values.length + 1)}`);
    values.push(query.relation);
  }
  if (query.resource !== undefined) {
    clauses.push(
      `resource_type = $${String(values.length + 1)}`,
      `resource_id = $${String(values.length + 2)}`,
    );
    values.push(query.resource.type, query.resource.id);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const sql =
    "SELECT subject_type, subject_id, relation, resource_type, resource_id" +
    ` FROM relationships${where}` +
    " ORDER BY subject_type, subject_id, relation, resource_type, resource_id";
  return { sql, values };
}

function assertIdentifierRef(value: unknown, field: string): void {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { type?: unknown }).type !== "string" ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    throw new ValidationError(field, "must be a parsed identifier { type, id }");
  }
}

/**
 * Read the current relationship-state version (Phase 7, cache invalidation).
 *
 * This is the relationship half of a version-keyed decision-cache entry: a
 * decision cached against version V stays reachable until a *write* advances
 * the sequence, so invalidation is key arithmetic rather than a scan.
 *
 * The read is side-effect free: it inspects the sequence's current value
 * without consuming one. An earlier revision used `nextval` here, which
 * incremented the version on every read — building a cache key would itself
 * have invalidated the entry it was keying. Returned as a string because that
 * is what node-postgres hands back for a sequence value; callers must treat
 * it as an opaque token, never parse it.
 */
export async function getRelationshipVersion(db: PgQueryable): Promise<string> {
  try {
    const result = await db.query<{ version: string }>(
      "SELECT last_value::text AS version FROM relationship_state_version",
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("relationship_state_version returned no row");
    }
    return row.version;
  } catch (error) {
    throw persistenceError("getRelationshipVersion", error);
  }
}

/**
 * Bump the relationship-state version without changing any row.
 *
 * Exported for transaction bodies that mutate `relationships` through paths
 * other than {@link PostgresRelationshipWriter}: any transaction that changes a
 * row must bump the sequence inside the **same** transaction, or a concurrent
 * reader can observe new data at the old version.
 */
export async function bumpRelationshipVersion(tx: PgQueryExecutor): Promise<void> {
  await tx.query("SELECT nextval('relationship_state_version')");
}

/**
 * Write surface for the Postgres store. Not part of the core read interface —
 * the evaluator never writes — so it lives here and satisfies the conformance
 * suite's `RelationshipWriter` (ADR-0018 S5).
 *
 * Every mutation bumps the relationship-state version (Phase 7): a decision
 * cache keyed on the version is only sound if no write can slip past it. The
 * bump is conditional on the write changing a row — an `ON CONFLICT DO NOTHING`
 * no-op or a delete of nothing changes no state, so it changes no version.
 * Bumping on no-ops would be safe but would evict the whole cache on every
 * retry, which is exactly the traffic pattern idempotent writes produce.
 */
export class PostgresRelationshipWriter {
  private readonly db: PgQueryable;

  constructor(db: PgQueryable) {
    this.db = db;
  }

  /**
   * Opaque state token (ADR-0018 S11): the `relationship_state_version`
   * sequence value. Side-effect free — observes via `last_value`, never
   * `nextval`, so building a cache key cannot invalidate the entry it keys.
   */
  async getVersion(): Promise<string> {
    return getRelationshipVersion(this.db);
  }

  /** Idempotent insert. Returns the stored relationship. */
  async add(input: unknown): Promise<Relationship> {
    const rel = parseRelationship(input);
    try {
      // One transaction for the row and the bump: an insert that commits while
      // its bump is lost (or vice versa) would leave new data addressable at
      // the old version — a phantom window a version-keyed cache cannot see.
      await this.db.transaction("READ COMMITTED", async (tx) => {
        const result = await tx.query<{ inserted: boolean }>(
          `INSERT INTO relationships (subject_type, subject_id, relation, resource_type, resource_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ON CONSTRAINT relationships_pkey DO NOTHING
           RETURNING true AS inserted`,
          [rel.subject.type, rel.subject.id, rel.relation, rel.resource.type, rel.resource.id],
        );
        // RETURNING yields a row only when a row was actually inserted. A retried
        // add of an existing edge changes no state, so it must not change the
        // version — or every retry would evict the whole decision cache.
        if (result.rows.length > 0) {
          await tx.query("SELECT nextval('relationship_state_version')");
        }
      });
    } catch (error) {
      throw persistenceError("addRelationship", error);
    }
    return rel;
  }

  /**
   * Atomic batch insert within a single transaction.
   *
   * If any relationship fails validation or insertion, the entire batch is
   * rolled back, ensuring atomic all-or-nothing writes (ADR-0018 S2/S5).
   */
  async addBatch(inputs: readonly unknown[]): Promise<readonly Relationship[]> {
    const relationships = inputs.map((input) => parseRelationship(input));
    try {
      return await this.db.transaction("READ COMMITTED", async (tx) => {
        let inserted = 0;
        for (const rel of relationships) {
          const result = await tx.query(
            `INSERT INTO relationships (subject_type, subject_id, relation, resource_type, resource_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT ON CONSTRAINT relationships_pkey DO NOTHING
             RETURNING true AS inserted`,
            [rel.subject.type, rel.subject.id, rel.relation, rel.resource.type, rel.resource.id],
          );
          inserted += result.rows.length;
        }
        // One bump per batch, not per row: the version marks *that* something
        // changed, not how much changed, and the whole batch commits atomically.
        if (inserted > 0) {
          await tx.query("SELECT nextval('relationship_state_version')");
        }
        return Object.freeze([...relationships]);
      });
    } catch (error) {
      throw persistenceError("addBatch", error);
    }
  }

  /**
   * Idempotent delete; returns whether a row was actually removed. Removing an
   * absent relationship succeeds, so a retried delete is safe — and bumps
   * nothing, for the same reason a no-op add bumps nothing.
   */
  async remove(input: unknown): Promise<boolean> {
    const rel = parseRelationship(input);
    try {
      // Same transaction for the delete and the bump, for the same reason as
      // `add`: a removed row committed at the old version is a revocation the
      // cache cannot see — the one failure mode that is a breach, not a bug.
      return await this.db.transaction("READ COMMITTED", async (tx) => {
        const result = await tx.query(
          `DELETE FROM relationships
           WHERE subject_type = $1 AND subject_id = $2 AND relation = $3
             AND resource_type = $4 AND resource_id = $5`,
          [rel.subject.type, rel.subject.id, rel.relation, rel.resource.type, rel.resource.id],
        );
        const removed = result.rowCount > 0;
        if (removed) {
          await tx.query("SELECT nextval('relationship_state_version')");
        }
        return removed;
      });
    } catch (error) {
      throw persistenceError("removeRelationship", error);
    }
  }
}
