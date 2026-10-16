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
 */
import { readFileSync } from "node:fs";
import { ArtifactLoader, DataPlaneServer } from "../dist/index.js";
import { Evaluator, InMemoryRelationshipStore } from "@uae/evaluator";
import { InMemoryPolicyStore } from "@uae/policy";

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

async function main() {
  const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);
  const apiKeys = (process.env["UAE_API_KEYS"] ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

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

  const relationships = new InMemoryRelationshipStore();
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: relationships.asRelationshipStore(),
  });

  const server = new DataPlaneServer(evaluator, { port, apiKeys });
  await server.listen();
  logEvent({
    level: "info",
    event: "data_plane_listening",
    port,
    auth: apiKeys.length > 0 ? "api-key" : "dev-mode",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      logEvent({ level: "info", event: "shutdown", signal });
      void server.close().then(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  logEvent({
    level: "error",
    event: "startup_failed",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
