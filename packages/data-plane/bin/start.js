#!/usr/bin/env node
/**
 * Data-plane entrypoint (ADR-0007). All configuration comes from environment
 * variables:
 *
 *   PORT                  Listen port (default 3000).
 *   UAE_API_KEYS          Comma-separated API keys. Unset = dev mode (no auth):
 *                         every request is accepted. Never run dev mode in
 *                         production.
 *   UAE_ARTIFACT_PATH     Path to a compiled policy artifact JSON. Unset or
 *                         empty = the server starts with an empty store and
 *                         every check fails closed (HTTP 503) until an
 *                         artifact is provided.
 *   UAE_PUBLIC_KEYS_PATH  Path to a JSON map of `keyId -> PEM public key` used
 *                         to verify artifact signatures (ADR-0024). Default:
 *                         no keys.
 *   UAE_REQUIRE_SIGNATURE "true" rejects unsigned artifacts (fail-closed).
 *   UAE_PG_URL            PostgreSQL connection string for relationship reads.
 *                         Unset = in-memory relationship store with nothing in
 *                         it: relationship-dependent checks fail closed.
 *                         Production deployments must set this.
 *   UAE_RUN_MIGRATIONS    "true" applies the bundled SQL migrations at startup
 *                         (idempotent; recorded in uae_schema_migrations).
 *   UAE_MAX_BODY_BYTES    Request body cap in bytes (default 1048576).
 *                         Larger bodies are rejected with HTTP 413.
 *   UAE_RATE_LIMIT_PER_MINUTE  Fixed-window request limit per API key (per
 *                         client address in dev mode) on /check and
 *                         /checkBatch. Default 0 = disabled; beyond the limit
 *                         requests get HTTP 429.
 */
import { readFileSync } from "node:fs";
import { ArtifactLoader, DataPlaneServer, DEFAULT_MAX_BODY_BYTES } from "../dist/index.js";
import { Evaluator, InMemoryRelationshipStore } from "@uae/evaluator";
import { InMemoryPolicyStore } from "@uae/policy";
import { PostgresRelationshipStore, createPgQueryable, runMigrations } from "@uae/persistence";

/** Open database handle, kept so fatal startup/shutdown can release it. */
let dbHandle = null;

/** Structured JSON logging, one object per line (matches the server). */
function logEvent(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

/** Read the `keyId -> PEM` map, or `{}` when not configured. */
function readPublicKeys() {
  const path = process.env["UAE_PUBLIC_KEYS_PATH"];
  if (path === undefined || path.length === 0) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Parse a non-negative integer env var; fall back (with a warning) on junk. */
function intFromEnv(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    logEvent({ level: "warn", event: "invalid_env_value", name, value: raw, using: fallback });
    return fallback;
  }
  return value;
}

async function main() {
  const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);
  const apiKeys = (process.env["UAE_API_KEYS"] ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  const maxBodyBytes = intFromEnv("UAE_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, 1);
  const rateLimitPerMinute = intFromEnv("UAE_RATE_LIMIT_PER_MINUTE", 0, 0);

  const artifactPath = process.env["UAE_ARTIFACT_PATH"];
  let policyStore;
  if (artifactPath === undefined || artifactPath.length === 0) {
    logEvent({
      level: "warn",
      event: "no_artifact_configured",
      message: "no policy artifact configured; all checks fail closed (503)",
    });
    policyStore = new InMemoryPolicyStore();
  } else {
    const loader = new ArtifactLoader({
      artifactPath,
      publicKeys: readPublicKeys(),
      requireSignature: process.env["UAE_REQUIRE_SIGNATURE"] === "true",
    });
    await loader.load();
    policyStore = loader.policyStore;
    logEvent({ level: "info", event: "artifact_loaded", artifactPath });
  }

  const pgUrl = process.env["UAE_PG_URL"];
  let relationshipStore;
  if (pgUrl === undefined || pgUrl.length === 0) {
    logEvent({
      level: "warn",
      event: "in_memory_relationships",
      message:
        "UAE_PG_URL not set; relationship store is empty in memory — relationship-dependent checks fail closed",
    });
    relationshipStore = new InMemoryRelationshipStore().asRelationshipStore();
  } else {
    const db = createPgQueryable({ connectionString: pgUrl });
    dbHandle = db;
    await db.query("SELECT 1"); // fail fast when the database is unreachable
    if (process.env["UAE_RUN_MIGRATIONS"] === "true") {
      await runMigrations(db);
      logEvent({ level: "info", event: "migrations_applied" });
    }
    relationshipStore = new PostgresRelationshipStore(db);
    logEvent({ level: "info", event: "relationship_store_ready", backend: "postgres" });
  }

  const evaluator = new Evaluator({ policyStore, relationshipStore });

  const server = new DataPlaneServer(evaluator, {
    port,
    apiKeys,
    policyVersion: () => policyStore.getActiveVersion(),
    maxBodyBytes,
    rateLimitPerMinute,
  });
  await server.listen();
  logEvent({
    level: "info",
    event: "data_plane_listening",
    port,
    auth: apiKeys.length > 0 ? "api-key" : "dev-mode",
    relationships: dbHandle === null ? "in-memory" : "postgres",
    rateLimitPerMinute,
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      logEvent({ level: "info", event: "shutdown", signal });
      void (async () => {
        try {
          await server.close();
          if (dbHandle !== null) await dbHandle.end();
          process.exit(0);
        } catch (error) {
          logEvent({
            level: "error",
            event: "shutdown_failed",
            message: error instanceof Error ? error.message : String(error),
          });
          process.exit(1);
        }
      })();
    });
  }
}

main().catch(async (error) => {
  logEvent({
    level: "error",
    event: "startup_failed",
    message: error instanceof Error ? error.message : String(error),
  });
  // Release the pool before exiting: pg's keepalive timers would otherwise
  // hold the event loop open and the process would hang instead of failing.
  if (dbHandle !== null) {
    try {
      await dbHandle.end();
    } catch {
      /* best effort */
    }
  }
  process.exitCode = 1;
});
