import { Relationship, RelationshipQuery, RelationshipStore } from "@uae/core";

/**
 * Access-pattern instrumentation (Phase 6, ADR-0017).
 *
 * ADR-0017 must justify the database choice from *measured* access patterns,
 * not assumptions. This wrapper records the query shapes the evaluator actually
 * issues so the benchmark harness can report them.
 *
 * Design constraints (ADR-0005, ADR-0010):
 * - **Pure**: it counts and times, but never logs, never mutates, and never
 *   changes a decision. Evaluation stays side-effect free.
 * - **Transparent**: every read delegates unchanged, so snapshot-consistency
 *   semantics of the wrapped store are preserved exactly.
 * - **Opt-in**: absent instrumentation there is no overhead at all.
 *
 * Only three query shapes are issued by the evaluator today:
 * | shape | issued by |
 * | --- | --- |
 * | `subject+relation+resource` | `evalRelation` (direct edge probe) |
 * | `subject+relation`           | forward `indirect` traversal |
 * | `resource+relation`          | reverse `indirect` traversal |
 */
export type RelationshipQueryShape =
  "subject+relation+resource" | "subject+relation" | "resource+relation" | "unbound";

/** Timing source, injectable so benchmarks are deterministic under test. */
export type MonotonicClock = () => number;

interface ShapeStats {
  calls: number;
  results: number;
  totalMs: number;
  maxMs: number;
  /** Result-set sizes, for fan-out distribution (bounded sample). */
  resultSizes: number[];
}

const MAX_SAMPLED_SIZES = 1024;

/** Aggregate access-pattern report (see {@link InstrumentedRelationshipStore}). */
export interface RelationshipStoreReport {
  readonly totalCalls: number;
  readonly totalResults: number;
  readonly byShape: Readonly<Record<RelationshipQueryShape, ShapeStats>>;
  readonly elapsedMs: number;
}

/** Classify a query by which positions are bound. */
export function queryShape(query: RelationshipQuery): RelationshipQueryShape {
  const subject = query.subject !== undefined;
  const relation = query.relation !== undefined;
  const resource = query.resource !== undefined;
  if (subject && relation && resource) return "subject+relation+resource";
  if (subject && relation) return "subject+relation";
  if (resource && relation) return "resource+relation";
  return "unbound";
}

function emptyStats(): ShapeStats {
  return { calls: 0, results: 0, totalMs: 0, maxMs: 0, resultSizes: [] };
}

/**
 * Wraps a {@link RelationshipStore} and records per-shape call counts, result
 * counts, and latency. Reads are delegated verbatim; the wrapper adds no
 * ordering, filtering, or caching of its own.
 */
export class InstrumentedRelationshipStore implements RelationshipStore {
  private readonly inner: RelationshipStore;
  private readonly now: MonotonicClock;
  private readonly stats: Record<RelationshipQueryShape, ShapeStats> = {
    "subject+relation+resource": emptyStats(),
    "subject+relation": emptyStats(),
    "resource+relation": emptyStats(),
    unbound: emptyStats(),
  };
  private readonly startedAt: number;

  constructor(inner: RelationshipStore, now: MonotonicClock = defaultClock) {
    this.inner = inner;
    this.now = now;
    this.startedAt = now();
  }

  async getRelationships(query: RelationshipQuery): Promise<readonly Relationship[]> {
    const shape = queryShape(query);
    const start = this.now();
    const rows = await this.inner.getRelationships(query);
    const elapsed = this.now() - start;
    this.record(shape, rows.length, elapsed);
    return rows;
  }

  /** Snapshot the accumulated report. */
  report(): RelationshipStoreReport {
    return {
      totalCalls: sumShape(this.stats, "calls"),
      totalResults: sumShape(this.stats, "results"),
      byShape: this.stats,
      elapsedMs: this.now() - this.startedAt,
    };
  }

  /** Drop accumulated counters (useful between benchmark phases). */
  reset(): void {
    for (const key of Object.keys(this.stats) as RelationshipQueryShape[]) {
      this.stats[key] = emptyStats();
    }
  }

  private record(shape: RelationshipQueryShape, results: number, elapsedMs: number): void {
    const stats = this.stats[shape];
    stats.calls += 1;
    stats.results += results;
    stats.totalMs += elapsedMs;
    if (elapsedMs > stats.maxMs) stats.maxMs = elapsedMs;
    if (stats.resultSizes.length < MAX_SAMPLED_SIZES) stats.resultSizes.push(results);
  }
}

function sumShape(
  stats: Readonly<Record<RelationshipQueryShape, ShapeStats>>,
  key: "calls" | "results",
): number {
  let total = 0;
  for (const shape of Object.keys(stats) as RelationshipQueryShape[]) {
    total += stats[shape][key];
  }
  return total;
}

function defaultClock(): number {
  return performance.now();
}

/** Mean/p50/p95/max over the sampled result sizes of one query shape. */
export function percentiles(stats: ShapeStats): {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
} {
  const sizes = [...stats.resultSizes].sort((a, b) => a - b);
  if (sizes.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const at = (q: number): number =>
    sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))] ?? 0;
  return {
    mean: sizes.reduce((sum, n) => sum + n, 0) / sizes.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sizes[sizes.length - 1] ?? 0,
  };
}
