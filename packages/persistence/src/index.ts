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
  bumpRelationshipVersion,
  getRelationshipVersion,
} from "./postgres-relationship-store.js";
export { PostgresPolicyStore } from "./postgres-policy-store.js";
export {
  PersistenceError,
  StoreTimeoutError,
  StoreUnavailableError,
  isPersistenceError,
  persistenceError,
} from "./errors.js";
export type { PersistenceErrorReason } from "./errors.js";
export { MIGRATIONS_TABLE, runMigrations } from "./migrate.js";
export {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  attachPoolErrorHandler,
  createPgQueryable,
  handlePoolError,
  normalizeQueryResult,
  poolConfig,
} from "./pg-adapter.js";
export type { PgConnectionOptions, PoolErrorSource } from "./pg-adapter.js";
export { readJson } from "./pool.js";
export type { PgQueryable, PgQueryExecutor, PgQueryResult } from "./pool.js";
