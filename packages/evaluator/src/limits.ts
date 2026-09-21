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
}) => void;
