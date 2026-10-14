import { Relationship, RelationshipQuery, RelationshipStore, ValidationError } from "@uae/core";
import { canonicalJson } from "@uae/policy";
import { EntryMap } from "./entry-map.js";

/**
 * Generation-keyed relationship query cache (ADR-0023,
 * `docs/architecture/caching.md` "Relationship cache").
 *
 * The evaluator's traversal queries the store through this cache when one is
 * configured. Entries are keyed by the query **and the opaque state version
 * (generation) the current check was keyed on** — the same invalidation
 * discipline as the decision cache (ADR-0021 §2), applied to reads instead
 * of decisions: when the relationship-state version moves (ADR-0018 S11),
 * entries from the previous generation become unreachable, because a lookup
 * must first read the current version. A cache can therefore never serve a
 * row the current state does not support.
 *
 * TTL and LRU capacity are memory hygiene only: an expired entry causes a
 * miss, never a wrong answer.
 *
 * What it buys: checks that share sub-traversals within one state version —
 * many documents in one project, many members of one group — repeat the
 * project-level probes only once. The decision cache (ADR-0021) collapses
 * whole checks; this collapses the *reads inside* checks that are not
 * themselves repeats.
 */
export class RelationshipCache {
  private readonly inner: RelationshipStore;
  private readonly entries: EntryMap<readonly Relationship[]>;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(inner: RelationshipStore, options: RelationshipCacheOptions = {}) {
    this.inner = inner;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new ValidationError(
        "relationshipCache.maxEntries",
        "must be a positive integer — a cache that cannot hold an entry must be omitted instead",
      );
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1) {
      throw new ValidationError(
        "relationshipCache.ttlMs",
        "must be at least 1ms — TTL is hygiene, not invalidation (ADR-0023), but 0 would make the cache a no-op that still pays a version read",
      );
    }
    this.entries = new EntryMap(this.maxEntries, this.ttlMs, this.now);
  }

  /**
   * Rows for one query, under the check's state version. Rows are frozen
   * (ADR-0018 S6 discipline plus the ADR-0021 §5 poisoning defense): a
   * caller that mutated a cached row could rewrite what later hits serve.
   */
  async query(query: RelationshipQuery, generation: string): Promise<readonly Relationship[]> {
    const key = relationshipCacheKey(query, generation);
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const rows = freezeRows(await this.inner.getRelationships(query));
    this.entries.set(key, rows);
    return rows;
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): RelationshipCacheStats {
    const base = this.entries.stats();
    return {
      hits: base.hits,
      misses: base.misses,
      evictions: base.evictions,
      size: this.entries.size,
    };
  }
}

export interface RelationshipCacheOptions {
  /** LRU capacity. Default 10 000. */
  readonly maxEntries?: number;
  /**
   * Entry lifetime in milliseconds — memory hygiene only, never the
   * invalidation mechanism. Default 60 000.
   */
  readonly ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

export interface RelationshipCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly size: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 60_000;

/**
 * Build the cache key. The generation is the first array element, so entries
 * from a superseded state version are unreachable without any explicit
 * eviction. Canonical JSON keeps two identical queries in one entry
 * regardless of insertion order.
 *
 * The generation is an opaque token (ADR-0018 S11): it participates as a
 * string segment only — never parsed, ordered, or combined.
 */
export function relationshipCacheKey(query: RelationshipQuery, generation: string): string {
  return canonicalJson([
    generation,
    query.subject ?? null,
    query.relation ?? null,
    query.resource ?? null,
  ]);
}

/** Freeze the array and every row (recursively within each row). */
function freezeRows(rows: readonly Relationship[]): readonly Relationship[] {
  for (const row of rows) {
    deepFreeze(row);
  }
  return Object.freeze(rows);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (typeof value === "object" && value !== null) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
