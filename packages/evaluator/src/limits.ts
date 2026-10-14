/** Evaluation bounds (docs/adr/0010-evaluator-semantics.md). */
export interface EvaluationLimits {
  readonly maxTraversalDepth: number;
  readonly maxVisitedNodes: number;
  readonly maxBatchSize: number;
}

export const DEFAULT_LIMITS: EvaluationLimits = {
  maxTraversalDepth: 10,
  maxVisitedNodes: 1000,
  maxBatchSize: 100,
};

/** Structured trace events; the evaluator never logs directly (purity). */
export type EvaluationObserver = (event: {
  readonly stage: string;
  readonly detail?: string;
  /**
   * Milliseconds since the previous event of the same evaluation - per-stage
   * duration, the profiling and observability seed (Phase 7). `0` on the
   * first event of an evaluation. Present whenever an observer is configured.
   */
  readonly elapsedMs?: number;
}) => void;

/**
 * Per-evaluation stage emitter with timing.
 *
 * Timing state is **per evaluation**, not per evaluator: concurrent checks
 * share an `Evaluator`, so per-instance state would interleave their stage
 * durations. Created only when an observer is configured - with no observer
 * there is no clock overhead at all.
 */
export interface StageClock {
  emit(stage: string, detail?: string): void;
}

/** Build a {@link StageClock} around an observer. See {@link StageClock}. */
export function makeStageClock(observer: EvaluationObserver): StageClock {
  let previous: number | undefined;
  return {
    emit(stage, detail) {
      const now = performance.now();
      const elapsedMs = previous === undefined ? 0 : now - previous;
      previous = now;
      if (detail === undefined) {
        observer({ stage, elapsedMs });
      } else {
        observer({ stage, detail, elapsedMs });
      }
    },
  };
}
