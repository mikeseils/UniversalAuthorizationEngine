/**
 * Internal LRU + TTL entry map shared by the Phase 7 caches (decision,
 * policy, relationship — ADR-0021/0022/0023).
 *
 * Deliberately dumb: it stores values under string keys, expires them after
 * `ttlMs`, evicts least-recently-used entries beyond `maxEntries`, and
 * counts hits/misses/evictions. It knows nothing about what the values are
 * or how keys are built — every cache-specific rule (what may be stored,
 * how keys are constructed, what invalidation means) lives in the cache
 * class on top.
 *
 * TTL and capacity are memory hygiene only, never invalidation: an expired
 * entry causes a miss, never a wrong answer. Correctness comes from key
 * construction in the callers.
 */
export class EntryMap<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxEntries: number, ttlMs: number, now: () => number) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Look up a value; refreshes LRU recency on hit. `undefined` = miss. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      // Expired: drop it. The miss that follows is safe; serving it would not be.
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Re-insert to move to the most-recent end of the LRU order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /** Store a value, evicting the least-recently-used entries beyond capacity. */
  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): EntryMapStats {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
}

export interface EntryMapStats {
  readonly hits: number;
  readonly misses: number;
  /** Entries dropped by LRU capacity (TTL expiry counts as a miss). */
  readonly evictions: number;
}

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}
