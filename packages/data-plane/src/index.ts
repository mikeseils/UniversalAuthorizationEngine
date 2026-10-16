/**
 * @uae/data-plane — Data-plane authorization service.
 *
 * Consumes compiled, (optionally) signed policy artifacts and answers
 * `check`/`checkBatch` over HTTP without constant control-plane access
 * (ADR-0007). Fail-closed by design.
 */
export { DataPlaneServer } from "./server.js";
export { ArtifactLoader, type ArtifactLoaderOptions } from "./artifact-loader.js";
export { EvaluatorAdapter, type ClientRequest, type CheckOutcome } from "./evaluator-adapter.js";
export { AuthorizationUnavailableError } from "./evaluator-adapter.js";
