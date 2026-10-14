import {
  AuthorizationContext,
  AuthorizationDecision,
  ExplanationLevel,
  Identifier,
  ValidationError,
} from "@uae/core";
import { canonicalJson } from "@uae/policy";

/**
 * Version-keyed decision cache (ADR-0021, `docs/architecture/caching.md`).
 *
 * The cache never decides what is current — the **key** does. Entries are
 * addressed by `subject + action + resource + policyVersion +
 * relationshipVersion + explanationLevel + canonical(context)`; when the
 * relationship-state version moves (ADR-0018 S11), old entries become
 * unreachable because a lookup must first read the current version. TTL and
 * capacity are memory hygiene, not invalidation: an expired entry causes a
 * miss, never a wrong answer.
 *
 * Deliberately dumb: it stores finalized decisions and answers get/set. Version
 * reads, key construction, and evaluator-flow ordering live in `Evaluator`,
 * which is the layer that holds the state inputs.
 */
export class DecisionCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: DecisionCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new ValidationError(
        "decisionCache.maxEntries",
        "must be a positive integer — a cache that cannot hold an entry must be omitted instead",
      );
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1) {
      throw new ValidationError(
        "decisionCache.ttlMs",
        "must be at least 1ms — TTL is hygiene, not invalidation (ADR-0021 §4), but 0 would make the cache a no-op that still pays a version read",
      );
    }
  }

  /** Look up a decision; refreshes LRU recency on hit. */
  get(key: string): AuthorizationDecision | undefined {
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
    return entry.decision;
  }

  /**
   * Store a decision. Returns `false` — storing nothing — for `reason:
   * "error"` outcomes: an evaluation that could not complete is a transient
   * condition, and caching its fail-closed DENY would stretch an outage across
   * the TTL window (ADR-0021 §3).
   */
  set(key: string, decision: AuthorizationDecision): boolean {
    if (decision.reason === "error") return false;
    this.entries.delete(key);
    this.entries.set(key, { decision: deepFreeze(decision), expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): DecisionCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size,
    };
  }
}

export interface DecisionCacheOptions {
  /** LRU capacity; oldest entries are evicted first. Default 10 000. */
  readonly maxEntries?: number;
  /**
   * Entry lifetime in milliseconds — memory hygiene only, never the
   * invalidation mechanism (ADR-0021 §4). Default 60 000.
   */
  readonly ttlMs?: number;
  /** Injectable monotonic-ish clock for deterministic tests. */
  readonly now?: () => number;
}

export interface DecisionCacheStats {
  readonly hits: number;
  readonly misses: number;
  /** Entries dropped by LRU capacity (TTL expiry counts as a miss). */
  readonly evictions: number;
  readonly size: number;
}

interface Entry {
  readonly decision: AuthorizationDecision;
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 60_000;

/**
 * Inputs for {@link decisionCacheKey}. All of them are already known to the
 * evaluator before evaluation starts — the key must be constructible *before*
 * the evaluation it may short-circuit (ADR-0021 §2).
 */
export interface DecisionCacheKeyInput {
  readonly subject: Identifier;
  readonly action: string;
  readonly resource: Identifier;
  readonly policyVersion: string;
  readonly relationshipVersion: string;
  readonly explanationLevel: ExplanationLevel;
  readonly context: AuthorizationContext;
}

/**
 * Build the cache key. Canonical JSON (recursively sorted object keys) makes
 * two contexts with identical content share an entry regardless of insertion
 * order, and two contexts with different content never share one.
 *
 * `relationshipVersion` is an opaque token: it participates as a string
 * segment only — never parsed, ordered, or combined (ADR-0018 S11).
 */
export function decisionCacheKey(input: DecisionCacheKeyInput): string {
  return canonicalJson([
    input.subject.type,
    input.subject.id,
    input.action,
    input.resource.type,
    input.resource.id,
    input.policyVersion,
    input.relationshipVersion,
    input.explanationLevel,
    input.context,
  ]);
}

/** Deep-freeze a value in place (same discipline as compiled policy artifacts). */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (typeof value === "object" && value !== null) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
