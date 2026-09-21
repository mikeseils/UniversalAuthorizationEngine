import { Relationship, RelationshipQuery } from "./relationship.js";

/**
 * A versioned, immutable policy artifact (ADR-0007). Policies are published
 * once and never mutated; evaluation always cites an exact version.
 * DRAFT type — the compiled representation will be defined by the
 * policy-language ADR (Phase 3).
 */
export interface VersionedPolicy {
  /** Immutable artifact version (e.g. `"42"`). */
  readonly version: string;
  /** Content hash of the artifact (used for reproducibility/audit). */
  readonly hash: string;
  /** Compiled policy body; opaque at this layer. */
  readonly artifact: unknown;
}

/** Source policy awaiting compilation/validation (publish-time input). */
export interface PolicySource {
  /** Structured policy content (Phase 2); source syntax arrives in Phase 3. */
  readonly source: unknown;
}

/**
 * Retrieval and publication of versioned policies
 * (docs/architecture/storage.md). The evaluator depends on this interface —
 * never on PostgreSQL, Redis, DynamoDB, etc. DRAFT interface.
 */
export interface PolicyStore {
  getActivePolicy(): Promise<VersionedPolicy>;
  getPolicyVersion(version: string): Promise<VersionedPolicy | null>;
  publishPolicy(policy: PolicySource): Promise<VersionedPolicy>;
}

/**
 * Retrieval of relationship records (docs/architecture/storage.md). Any query
 * field may be unbound to match "all" for that position. Implementations must
 * return a consistent snapshot for a single evaluation.
 * DRAFT interface.
 */
export interface RelationshipStore {
  getRelationships(query: RelationshipQuery): Promise<readonly Relationship[]>;
}
