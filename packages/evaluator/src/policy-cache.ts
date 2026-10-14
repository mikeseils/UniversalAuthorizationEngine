import { ValidationError, VersionedPolicy } from "@uae/core";
import { EntryMap } from "./entry-map.js";

/**
 * Version-keyed policy artifact cache (ADR-0022, `docs/architecture/caching.md`).
 *
 * Compiled policy artifacts are immutable and content-addressed (ADR-0018 S8):
 * a version either holds a complete artifact or none, and republishing mints
 * a *new* version rather than mutating one. Keying by version therefore needs
 * no invalidation logic at all — a superseded version simply stops being
 * looked up, exactly like a superseded relationship version in the decision
 * cache (ADR-0021). TTL and LRU capacity are memory hygiene: they free
 * artifacts of versions that fell out of use, and an expired entry causes a
 * miss, never a wrong answer.
 *
 * On PostgreSQL this turns the per-check active-policy read from two
 * round-trips (pointer, then artifact) into one (pointer, then cache hit),
 * including on decision-cache hits, where the artifact is never otherwise
 * needed again.
 */
export class PolicyCache {
  private readonly entries: EntryMap<VersionedPolicy>;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PolicyCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new ValidationError(
        "policyCache.maxEntries",
        "must be a positive integer — a cache that cannot hold an entry must be omitted instead",
      );
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1) {
      throw new ValidationError(
        "policyCache.ttlMs",
        "must be at least 1ms — TTL is hygiene, not invalidation (ADR-0022), but 0 would make the cache a no-op that still pays a version read",
      );
    }
    this.entries = new EntryMap(this.maxEntries, this.ttlMs, this.now);
  }

  /** Look up a compiled artifact by version; refreshes LRU recency on hit. */
  get(version: string): VersionedPolicy | undefined {
    return this.entries.get(version);
  }

  /** Store a compiled artifact under its version. Later versions never collide. */
  set(version: string, policy: VersionedPolicy): void {
    this.entries.set(version, Object.freeze(policy));
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): PolicyCacheStats {
    const base = this.entries.stats();
    return {
      hits: base.hits,
      misses: base.misses,
      evictions: base.evictions,
      size: this.entries.size,
    };
  }
}

export interface PolicyCacheOptions {
  /**
   * LRU capacity. Artifacts can be large (compiled definitions), so the
   * default is deliberately small: a handful of versions covers normal
   * operation, and anything else is bounded by the LRU anyway.
   */
  readonly maxEntries?: number;
  /** Entry lifetime in ms — memory hygiene only, never invalidation. Default 300 000. */
  readonly ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

export interface PolicyCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly size: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 300_000;
