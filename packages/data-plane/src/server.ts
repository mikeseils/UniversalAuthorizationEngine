import { createServer, type Server } from "node:http";
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
      ].join("\n") + "\n"
    );
  }
}

/**
 * Data-plane HTTP server (ADR-0007).
 *
 * Consumes a compiled policy artifact and answers authorization checks without
 * constant control-plane access. Endpoints:
 *   POST /check     — single authorization check
 *   POST /checkBatch — batch of authorization checks
 *   GET /healthz    — health check (no auth required)
 *   GET /version    — current policy artifact version
 *   GET /metrics    — Prometheus metrics
 *
 * Fail-closed: store unavailability → 503, never a silent DENY/ALLOW.
 * API key authentication is required on all endpoints except /healthz and /metrics.
 */
export class DataPlaneServer {
  private readonly port: number;
  private readonly adapter: EvaluatorAdapter;
  private readonly apiKeys: ReadonlySet<string>;
  private readonly metrics: Metrics;
  private server: Server | null = null;

  constructor(evaluator: Evaluator, opts: { port?: number; apiKeys?: readonly string[] } = {}) {
    this.port = opts.port ?? 3000;
    this.adapter = new EvaluatorAdapter(evaluator);
    this.apiKeys = new Set(opts.apiKeys ?? []);
    this.metrics = new Metrics();
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
  private authenticate(req: import("node:http").IncomingMessage): boolean {
    if (this.apiKeys.size === 0) return true;
    const auth = req.headers["authorization"];
    const key =
      typeof auth === "string" && auth.startsWith("Bearer ")
        ? auth.slice(7)
        : req.headers["x-api-key"];
    return typeof key === "string" && this.apiKeys.has(key);
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

    try {
      if (method === "GET" && url === "/healthz") {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok" }));
        this.metrics.incChecksTotal();
        this.metrics.incChecksAllowed();
        this.log("check", req, 200, startMs, "allowed");
        return;
      }
      if (method === "GET" && url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(this.metrics.toPrometheus());
        return;
      }
      if (method === "GET" && url === "/version") {
        // Version comes from the evaluator's policy store — not yet exposed
        // through EvaluatorAdapter; return a placeholder for Phase 2 of WS-2.
        res.writeHead(501);
        res.end(JSON.stringify({ error: "not implemented" }));
        return;
      }
      if (method === "POST" && url === "/check") {
        const body = (await readJsonBody(req)) as ClientRequest;
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
        const body = await readJsonBody(req);
        if (!Array.isArray(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "request body must be an array" }));
          return;
        }
        const outcomes = await this.adapter.checkBatch(body as ClientRequest[]);
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
      res.writeHead(500);
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: string | Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      if (data.length === 0) resolve({});
      else {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("invalid JSON body"));
        }
      }
    });
    req.on("error", reject);
  });
}
