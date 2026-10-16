import { createServer, type Server } from "node:http";
import { Evaluator } from "@uae/evaluator";
import { EvaluatorAdapter, type ClientRequest } from "./evaluator-adapter.js";

/**
 * Data-plane HTTP server (ADR-0007).
 *
 * Consumes a compiled policy artifact and answers authorization checks without
 * constant control-plane access. Endpoints:
 *   POST /check     — single authorization check
 *   POST /checkBatch — batch of authorization checks
 *   GET /healthz    — health check (no auth required)
 *   GET /version    — current policy artifact version
 *
 * Fail-closed: store unavailability → 503, never a silent DENY/ALLOW.
 * API key authentication is required on all endpoints except /healthz.
 */
export class DataPlaneServer {
  private readonly port: number;
  private readonly adapter: EvaluatorAdapter;
  private readonly apiKeys: ReadonlySet<string>;
  private server: Server | null = null;

  constructor(evaluator: Evaluator, opts: { port?: number; apiKeys?: readonly string[] } = {}) {
    this.port = opts.port ?? 3000;
    this.adapter = new EvaluatorAdapter(evaluator);
    this.apiKeys = new Set(opts.apiKeys ?? []);
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
    res.setHeader("Content-Type", "application/json");

    // Health check is unauthenticated (for load balancers).
    const isHealthz = method === "GET" && url === "/healthz";
    if (!isHealthz && !this.authenticate(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      if (method === "GET" && url === "/healthz") {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok" }));
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
