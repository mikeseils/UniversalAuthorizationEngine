import {
  Relationship,
  RelationshipQuery,
  VersionedRelationshipStore,
  parseRelationship,
} from "@uae/core";

/**
 * In-memory `RelationshipStore` (Phase 2): unit tests, local development,
 * examples (docs/architecture/storage.md). Not a persistent backend.
 *
 * - Mutations are idempotent (adding an existing relationship is a no-op).
 * - Reads are snapshot-consistent: a single `getRelationships` call never
 *   mixes pre- and post-mutation state.
 * - A monotonically increasing `relationshipVersion` tracks state changes —
 *   groundwork for state-versioned cache keys (docs/architecture/caching.md).
 */
export class InMemoryRelationshipStore {
  private readonly edges = new Map<string, Relationship>();
  private versionCounter = 0;

  /** Current relationship state version (changes on any mutation). */
  get relationshipVersion(): number {
    return this.versionCounter;
  }

  /**
   * Opaque state token (ADR-0018 S11): the counter rendered as a string.
   * Side-effect free — reading never advances it.
   */
  getRelationshipVersion(): Promise<string> {
    return Promise.resolve(String(this.versionCounter));
  }

  /** Add a relationship (idempotent). Accepts `type:id` strings or objects. */
  add(input: unknown): Relationship {
    const rel = parseRelationship(input);
    const key = edgeKey(rel);
    const existing = this.edges.get(key);
    if (existing !== undefined) return existing;
    this.edges.set(key, rel);
    this.versionCounter += 1;
    return rel;
  }

  /** Remove a relationship (idempotent, safe to retry). */
  remove(input: unknown): boolean {
    const rel = parseRelationship(input);
    const removed = this.edges.delete(edgeKey(rel));
    if (removed) this.versionCounter += 1;
    return removed;
  }

  /** Load a batch of relationships (e.g. from the canonical fixture). */
  addAll(inputs: readonly unknown[]): void {
    for (const input of inputs) this.add(input);
  }

  get size(): number {
    return this.edges.size;
  }

  /** Core `RelationshipStore` view over this store. */
  asRelationshipStore(): Pick<
    VersionedRelationshipStore,
    "getRelationships" | "getRelationshipVersion"
  > {
    return {
      getRelationships: (query: RelationshipQuery) => Promise.resolve(this.query(query)),
      getRelationshipVersion: () => this.getRelationshipVersion(),
    };
  }

  private query(query: RelationshipQuery): readonly Relationship[] {
    const matches: Relationship[] = [];
    for (const rel of this.edges.values()) {
      if (
        (query.subject === undefined ||
          (rel.subject.type === query.subject.type && rel.subject.id === query.subject.id)) &&
        (query.relation === undefined || rel.relation === query.relation) &&
        (query.resource === undefined ||
          (rel.resource.type === query.resource.type && rel.resource.id === query.resource.id))
      ) {
        matches.push(rel);
      }
    }
    return Object.freeze(matches);
  }
}

function edgeKey(rel: Relationship): string {
  return `${rel.subject.type}:${rel.subject.id}|${rel.relation}|${rel.resource.type}:${rel.resource.id}`;
}
