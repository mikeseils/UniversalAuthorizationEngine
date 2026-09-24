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
  /**
   * Non-fatal findings recorded at publish time (e.g. validation warnings).
   * Warnings are surfaced, never silently discarded, but they never change
   * whether a policy was accepted.
   */
  readonly warnings?: readonly string[];
}

/**
 * How {@link PolicySource.source} is expressed (ADR-0012):
 * - `structured` — the compiled representation's input shape (programmatic);
 * - `text` — policy language source (ADR-0012 syntax).
 * When omitted, a string `source` is treated as `text` and anything else as
 * `structured`, so both authoring styles reach the same publish path.
 */
export type PolicySourceFormat = "structured" | "text";

/** Source policy awaiting compilation/validation (publish-time input). */
export interface PolicySource {
  /** Optional explicit format; inferred from the `source` value when absent. */
  readonly format?: PolicySourceFormat;
  /** Structured policy content, or policy-language text when `format` is `text`. */
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
