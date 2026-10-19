import { createServer, type Server } from "node:http";
import { coerceIdentifier, parseAction, ValidationError } from "@uae/core";
import { Evaluator } from "@uae/evaluator";
import { EvaluatorAdapter, type ClientRequest } from "./evaluator-adapter.js";

/**
 * Structured JSON logger. Emits one JSON object per line to stdout.
 */
function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

/**
 * Counter metrics collected by the data plane. Exposed via GET /metrics in
 * Prometheus text exposition format.
 */
class Metrics {
  private checksTotal = 0;
  private checksAllowed = 0;
  private checksDenied = 0;
  private checksUnavailable = 0;
  private checksDurationMs = 0;
  private rateLimited = 0;

  incChecksTotal() {
    this.checksTotal += 1;
  }
  incChecksAllowed() {
    this.checksAllowed += 1;
  }
  incChecksDenied() {
    this.checksDenied += 1;
  }
  incChecksUnavailable() {
    this.checksUnavailable += 1;
  }
  addChecksDurationMs(ms: number) {
    this.checksDurationMs += ms;
  }
  incRateLimited() {
    this.rateLimited += 1;
  }

  /** Prometheus text exposition format. */
  toPrometheus(): string {
    const avgDurationMs = this.checksTotal > 0 ? this.checksDurationMs / this.checksTotal : 0;
    return (
      [
        `# HELP uae_checks_total Total number of authorization checks`,
        `# TYPE uae_checks_total counter`,
        `uae_checks_total ${String(this.checksTotal)}`,
        `# HELP uae_checks_allowed Total number of allowed authorization checks`,
        `# TYPE uae_checks_allowed counter`,
        `uae_checks_allowed ${String(this.checksAllowed)}`,
        `# HELP uae_checks_denied Total number of denied authorization checks`,
        `# TYPE uae_checks_denied counter`,
        `uae_checks_denied ${String(this.checksDenied)}`,
        `# HELP uae_checks_unavailable Total number of unavailable authorization checks`,
        `# TYPE uae_checks_unavailable counter`,
        `uae_checks_unavailable ${String(this.checksUnavailable)}`,
        `# HELP uae_checks_duration_ms Average check duration in milliseconds`,
        `# TYPE uae_checks_duration_ms gauge`,
        `uae_checks_duration_ms ${avgDurationMs.toFixed(3)}`,
        `# HELP uae_rate_limited_total Total requests rejected by the rate limiter`,
        `# TYPE uae_rate_limited_total counter`,
        `uae_rate_limited_total ${String(this.rateLimited)}`,
      ].join("\n") + "\n"
    );
  }
}

/** Optional configuration for {@link DataPlaneServer}. */
export interface DataPlaneServerOptions {
  readonly port?: number;
  readonly apiKeys?: readonly string[];
  /**
   * Reports the active policy version for `GET /version`. When omitted or
   * returning no version, `/version` fails closed with 503 — an unversioned
   * data plane never claims to be serving a policy it cannot name.
   */
  readonly policyVersion?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Max request body size in bytes; larger bodies are rejected with 413. Default: 1 MiB. */
  readonly maxBodyBytes?: number;
  /**
   * Fixed-window requests-per-minute on `/check` and `/checkBatch`, bucketed
   * per API key (per client address in dev mode). 0 (default) disables.
   */
  readonly rateLimitPerMinute?: number;
  /** Rate-limit window length in milliseconds. Default: 60 000. */
  readonly rateLimitWindowMs?: number;
}

/** Default request body cap (bytes): comfortably above any valid batch. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Data-plane HTTP server (ADR-0007).
 *
 * Consumes a compiled policy artifact and answers authorization checks without
 * constant control-plane access. Endpoints:
 *   POST /check      — single authorization check
 *   POST /checkBatch — batch of authorization checks
 *   GET  /healthz    — health check (no auth required, never counted as a check)
 *   GET  /version    — active policy artifact version (503 when none: fail-closed)
 *   GET  /metrics    — Prometheus metrics (no auth required)
 *
 * Error taxonomy: 400 invalid JSON body, 401 missing/invalid API key, 404
 * unknown route, 413 body too large, 429 rate limited, 503 store unavailable
 * (fail-closed), 500 unexpected internal error.
 *
 * Fail-closed: store unavailability → 503, never a silent DENY/ALLOW.
 * API key authentication is required on all endpoints except /healthz and /metrics.
 */
export class DataPlaneServer {
  private readonly port: number;
  private readonly adapter: EvaluatorAdapter;
  private readonly apiKeys: ReadonlySet<string>;
  private readonly metrics: Metrics;
  private readonly policyVersion: DataPlaneServerOptions["policyVersion"];
  private readonly maxBodyBytes: number;
  private readonly rateLimitPerMinute: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateBuckets = new Map<string, { windowStart: number; count: number }>();
  private server: Server | null = null;

  constructor(evaluator: Evaluator, opts: DataPlaneServerOptions = {}) {
    this.port = opts.port ?? 3000;
    this.adapter = new EvaluatorAdapter(evaluator);
    this.apiKeys = new Set(opts.apiKeys ?? []);
    this.metrics = new Metrics();
    this.policyVersion = opts.policyVersion;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.rateLimitPerMinute = opts.rateLimitPerMinute ?? 0;
    this.rateLimitWindowMs = opts.rateLimitWindowMs ?? 60_000;
  }

  /** Start listening. */
  listen(): Promise<void> {
    const server = createServer((req, res) => void this.handleRequest(req, res));
    return new Promise<void>((resolve, reject) => {
      server.once("listening", () => {
        resolve();
      });
      server.on("error", (err) => {
        reject(err);
      });
      server.listen(this.port);
    }).then(() => {
      this.server = server;
    });
  }

  /** Stop listening. */
  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    this.server = null;
  }

  /** The bound address, for tests. */
  address(): { port: number } | null {
    if (this.server === null) return null;
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") return null;
    return { port: addr.port };
  }

  /**
   * API key authentication. Accepts `Authorization: Bearer <key>` or
   * `X-API-Key: <key>`. Returns true when no keys are configured (dev mode)
   * or when the provided key matches one of the configured keys.
   */
  private presentedKey(req: import("node:http").IncomingMessage): string | null {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
    const key = req.headers["x-api-key"];
    return typeof key === "string" ? key : null;
  }

  private authenticate(req: import("node:http").IncomingMessage): boolean {
    if (this.apiKeys.size === 0) return true;
    const key = this.presentedKey(req);
    return key !== null && this.apiKeys.has(key);
  }

  /**
   * Fixed-window rate limit (threat model row 12), keyed by the presented API
   * key — or by client address in dev mode, where no keys exist to bucket by.
   * Returns true when the request may proceed. Disabled unless configured.
   */
  private allowRequest(req: import("node:http").IncomingMessage): boolean {
    if (this.rateLimitPerMinute <= 0) return true;
    const now = Date.now();
    if (this.rateBuckets.size > 10_000) {
      // Dev-mode buckets key on client IP and would otherwise grow without
      // bound; expired windows carry no state worth keeping.
      for (const [key, bucket] of this.rateBuckets) {
        if (now - bucket.windowStart >= this.rateLimitWindowMs) this.rateBuckets.delete(key);
      }
    }
    const credential = this.apiKeys.size > 0 ? (this.presentedKey(req) ?? "") : "";
    const bucketKey =
      credential.length > 0 ? `key:${credential}` : `ip:${req.socket.remoteAddress ?? "unknown"}`;
    let bucket = this.rateBuckets.get(bucketKey);
    if (bucket === undefined || now - bucket.windowStart >= this.rateLimitWindowMs) {
      bucket = { windowStart: now, count: 0 };
      this.rateBuckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.rateLimitPerMinute;
  }

  private async handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const { url, method } = req;
    const startMs = process.hrtime.bigint();
    res.setHeader("Content-Type", "application/json");

    // Health check and metrics are unauthenticated (for load balancers).
    const isHealthz = method === "GET" && url === "/healthz";
    const isMetrics = method === "GET" && url === "/metrics";
    if (!isHealthz && !isMetrics && !this.authenticate(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Rate limit the check endpoints only: ops probes (healthz/metrics) and
    // /version must stay answerable for exactly the traffic that measures them.
    const isCheck = method === "POST" && (url === "/check" || url === "/checkBatch");
    if (isCheck && !this.allowRequest(req)) {
      this.metrics.incRateLimited();
      res.writeHead(429);
      res.end(JSON.stringify({ error: "rate limit exceeded" }));
      this.log(url === "/checkBatch" ? "checkBatch" : "check", req, 429, startMs, "rate_limited");
      return;
    }

    try {
      if (method === "GET" && url === "/healthz") {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok" }));
        // Deliberately not counted as a check: probe traffic must not pollute
        // uae_checks_* (SLO/alert arithmetic reads those counters).
        this.log("healthz", req, 200, startMs, "ok");
        return;
      }
      if (method === "GET" && url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(this.metrics.toPrometheus());
        return;
      }
      if (method === "GET" && url === "/version") {
        const version = this.policyVersion === undefined ? null : await this.policyVersion();
        if (version === null || version === undefined || version.length === 0) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "no active policy version" }));
          this.log("version", req, 503, startMs, "unavailable");
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ version }));
        this.log("version", req, 200, startMs, "ok");
        return;
      }
      if (method === "POST" && url === "/check") {
        const body = assertCheckRequest(await readJsonBody(req, this.maxBodyBytes));
        const outcome = await this.adapter.check(body);
        const status = outcome.outcome === "unavailable" ? 503 : 200;
        res.writeHead(status);
        res.end(JSON.stringify(outcome));
        this.recordCheck(outcome, startMs);
        this.log(
          "check",
          req,
          status,
          startMs,
          outcome.outcome === "unavailable"
            ? "unavailable"
            : outcome.decision.allowed
              ? "allowed"
              : "denied",
        );
        return;
      }
      if (method === "POST" && url === "/checkBatch") {
        const raw = await readJsonBody(req, this.maxBodyBytes);
        if (!Array.isArray(raw)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "request body must be an array" }));
          return;
        }
        const requests: ClientRequest[] = [];
        for (const item of raw) {
          requests.push(assertCheckRequest(item));
        }
        const outcomes = await this.adapter.checkBatch(requests);
        const status = outcomes.some((o) => o.outcome === "unavailable") ? 503 : 200;
        res.writeHead(status);
        res.end(JSON.stringify(outcomes));
        for (const o of outcomes) {
          this.metrics.incChecksTotal();
          if (o.outcome === "unavailable") {
            this.metrics.incChecksUnavailable();
          } else if (o.decision.allowed) {
            this.metrics.incChecksAllowed();
          } else {
            this.metrics.incChecksDenied();
          }
        }
        this.log("checkBatch", req, status, startMs, "batch");
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      // RequestError carries the caller-facing status (400/413); anything else
      // is an unexpected internal failure and stays a 500.
      const status = error instanceof RequestError ? error.status : 500;
      res.writeHead(status);
      res.end(
        JSON.stringify({
          // Only surface caller-facing messages from RequestError (400/413).
          // Unexpected internal failures (500) return a generic message to avoid
          // leaking stack traces or internal details to the client; the real
          // error is already recorded server-side via this.log().
          error: error instanceof RequestError ? error.message : "internal server error",
        }),
      );
      const op = url === "/checkBatch" ? "checkBatch" : url === "/version" ? "version" : "check";
      this.log(op, req, status, startMs, status >= 500 ? "error" : "invalid_request");
    }
  }

  private recordCheck(
    outcome:
      | { outcome: "decision"; decision: { allowed: boolean } }
      | { outcome: "unavailable"; error: unknown },
    startMs: bigint,
  ): void {
    this.metrics.incChecksTotal();
    const durationMs = Number(process.hrtime.bigint() - startMs) / 1_000_000;
    this.metrics.addChecksDurationMs(durationMs);
    if (outcome.outcome === "unavailable") {
      this.metrics.incChecksUnavailable();
    } else if (outcome.decision.allowed) {
      this.metrics.incChecksAllowed();
    } else {
      this.metrics.incChecksDenied();
    }
  }

  private log(
    operation: string,
    req: import("node:http").IncomingMessage,
    status: number,
    startMs: bigint,
    outcome: string,
  ): void {
    const durationMs = Number(process.hrtime.bigint() - startMs) / 1_000_000;
    logEvent({
      ts: new Date().toISOString(),
      op: operation,
      method: req.method ?? "",
      path: req.url ?? "",
      status,
      durationMs: durationMs.toFixed(3),
      outcome,
    });
  }
}

/**
 * Caller-facing request error: the status code is part of the contract, so a
 * malformed body is a 400 and an oversized one a 413 — never an opaque 500.
 */
class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RequestError";
  }
}

/** Validate a caller-supplied check request at the boundary. Malformed caller
 * input (subject/action/resource/context) is rejected with 400, never coerced
 * or silently evaluated; genuine store/evaluator failures still surface as 503
 * from the adapter. */
function assertCheckRequest(body: unknown): ClientRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "request body must be a JSON object");
  }
  const req = body as Record<string, unknown>;
  try {
    coerceIdentifier(req.subject, "subject");
    parseAction(req.action);
    coerceIdentifier(req.resource, "resource");
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new RequestError(400, error.message);
    }
    throw error;
  }
  if (req.context !== undefined) {
    if (typeof req.context !== "object" || req.context === null || Array.isArray(req.context)) {
      throw new RequestError(400, "context must be a JSON object");
    }
    for (const [key, value] of Object.entries(req.context)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new RequestError(400, `context key "${key}" must be a string, number, or boolean`);
      }
    }
  }
  return req as ClientRequest;
}

async function readJsonBody(
  req: import("node:http").IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new RequestError(413, "request body too large"));
        req.resume(); // drain the rejected body so the 413 can be written
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const data = Buffer.concat(chunks).toString("utf8");
      if (data.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new RequestError(400, "invalid JSON body"));
      }
    });
    req.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
