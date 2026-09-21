/** Internal evaluation plumbing: combine ops, traversal, and dispatcher. */
export {
  type EvaluatorFn,
  type EvalResult,
  type EvalState,
  type TriValue,
  evalAllOf,
  evalAnyOf,
  evalContext,
  evalRelation,
  outcomeFor,
} from "./eval-ops.js";
export { evalIndirect, makeEvaluatorFn } from "./eval-indirect.js";
