import {
  Relationship,
  RelationshipQuery,
  RelationshipStore,
  ValidationError,
  parseRelationship,
} from "@uae/core";
import { persistenceError } from "./errors.js";
import { PgQueryable } from "./pool.js";

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
export class PostgresRelationshipStore implements RelationshipStore {
  private readonly db: PgQueryable;

  constructor(db: PgQueryable) {
    this.db = db;
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
 * Write surface for the Postgres store. Not part of the core read interface —
 * the evaluator never writes — so it lives here and satisfies the conformance
 * suite's `RelationshipWriter` (ADR-0018 S5).
 */
export class PostgresRelationshipWriter {
  private readonly db: PgQueryable;

  constructor(db: PgQueryable) {
    this.db = db;
  }

  /** Idempotent insert. Returns the stored relationship. */
  async add(input: unknown): Promise<Relationship> {
    const rel = parseRelationship(input);
    try {
      await this.db.query(
        `INSERT INTO relationships (subject_type, subject_id, relation, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ON CONSTRAINT relationships_pkey DO NOTHING`,
        [rel.subject.type, rel.subject.id, rel.relation, rel.resource.type, rel.resource.id],
      );
    } catch (error) {
      throw persistenceError("addRelationship", error);
    }
    return rel;
  }

  /**
   * Idempotent delete; returns whether a row was actually removed. Removing an
   * absent relationship succeeds, so a retried delete is safe.
   */
  async remove(input: unknown): Promise<boolean> {
    const rel = parseRelationship(input);
    try {
      const result = await this.db.query(
        `DELETE FROM relationships
         WHERE subject_type = $1 AND subject_id = $2 AND relation = $3
           AND resource_type = $4 AND resource_id = $5`,
        [rel.subject.type, rel.subject.id, rel.relation, rel.resource.type, rel.resource.id],
      );
      return result.rowCount > 0;
    } catch (error) {
      throw persistenceError("removeRelationship", error);
    }
  }
}
