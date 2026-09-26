/**
 * @uae/persistence — PostgreSQL-backed `RelationshipStore` and `PolicyStore`
 * (Phase 6, ADR-0017).
 *
 * The engine core stays dependency-free (ADR-0005): `pg` is confined to this
 * package, and both stores implement the core interfaces from `@uae/core`, so
 * the evaluator never learns which database is underneath.
 *
 * Every store in this package must satisfy the conformance suite in
 * `tests/store-conformance.ts` (ADR-0018).
 */
export {
  PostgresRelationshipStore,
  PostgresRelationshipWriter,
  buildQuery,
} from "./postgres-relationship-store.js";
export { PostgresPolicyStore } from "./postgres-policy-store.js";
export { PersistenceError, isPersistenceError, persistenceError } from "./errors.js";
export type { PersistenceErrorReason } from "./errors.js";
export { runMigrations } from "./migrate.js";
export { createPgQueryable } from "./pg-adapter.js";
export type { PgConnectionOptions } from "./pg-adapter.js";
export { readJson } from "./pool.js";
export type { PgQueryable, PgQueryExecutor, PgQueryResult } from "./pool.js";
