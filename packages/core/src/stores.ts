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
 * — `structured` — the compiled representation's input shape (programmatic);
 * — `text` — policy language source (ADR-0012 syntax).
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
  /**
   * Read the active version pointer without loading the artifact
   * (Phase 7 policy caching, ADR-0022).
   *
   * Optional for the same reason as {@link setActiveVersion}: a store whose
   * active-policy read is one atomic operation has no separate pointer
   * surface to expose. Where present it MAY be async. `null` means "nothing
   * is active" — callers must treat it exactly as `getActivePolicy` would,
   * which is a typed infrastructure error (ADR-0018 S9), never a fabricated
   * decision.
   */
  getActiveVersion?(): string | null | Promise<string | null>;
  publishPolicy(policy: PolicySource): Promise<VersionedPolicy>;
  /**
   * Explicitly activate a published version (deployment act, ADR-0018 S7).
   *
   * Optional because read-only data-plane facades may expose only the read
   * side. Where present it MAY be async: persistent backends must read the
   * version row and commit the deployment pointer before activation is
   * visible. Callers `await` unconditionally — awaiting a sync `void`
   * return is a harmless no-op.
   */
  setActiveVersion?(version: string): void | Promise<void>;
}

/**
 * A `PolicyStore` whose activation surface is present — the **control-plane**
 * view (ADR-0007).
 *
 * The read side and the deployment side are deliberately separable: a
 * data-plane facade may expose only reads, which is why `setActiveVersion` is
 * optional on {@link PolicyStore}. Code that *does* deploy policy (the CLI
 * activating a compiled file, the SDK publishing and activating) depends on
 * this view instead, so a store with no activation surface is a type error
 * rather than a silently skipped deployment.
 */
export type ActivatablePolicyStore = PolicyStore & {
  setActiveVersion(version: string): void | Promise<void>;
};

/**
 * Retrieval of relationship records (docs/architecture/storage.md). Any query
 * field may be unbound to match "all" for that position. Implementations must
 * return a consistent snapshot for a single evaluation.
 * DRAFT interface.
 */
export interface RelationshipStore {
  getRelationships(query: RelationshipQuery): Promise<readonly Relationship[]>;
}

/**
 * Optional state-version surface for relationship backends (ADR-0018 S11,
 * Phase 7 decision caching).
 *
 * A decision is cacheable only if it is addressable by the state that produced
 * it (`docs/architecture/caching.md` rule 1). The version is an **opaque
 * token**: monotone and global, saying only *that* something changed, never
 * *what* changed. Callers compare tokens with `!==` — they never parse, order,
 * or arithmetically combine them.
 *
 * Optional (not part of the read contract) so existing single-purpose
 * `RelationshipStore` facades keep working: a backend that cannot report state
 * simply cannot back a version-keyed decision cache. Where present it MUST be
 * side-effect free — observing the version must never advance it.
 */
export interface VersionedRelationshipStore extends RelationshipStore {
  getRelationshipVersion(): Promise<string>;
}
