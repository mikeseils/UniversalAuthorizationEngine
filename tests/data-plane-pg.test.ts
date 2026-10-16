import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryPolicyStore } from "../packages/policy/src/store.js";
import {
  PostgresRelationshipWriter,
  createPgQueryable,
  runMigrations,
  type PgQueryable,
} from "../packages/persistence/src/index.js";
import { ACME_POLICY } from "./helpers.js";

/**
 * End-to-end wiring test for `bin/start.js` against a real PostgreSQL (Phase 8
 * relationship ingestion): boots the actual entrypoint with `UAE_PG_URL`,
 * proves the decision used a relationship stored in the database (an empty
 * in-memory store could never answer `allowed: true` here), that `GET
 * /version` reports the loaded artifact, and that SIGTERM shuts down cleanly.
 *
 * Same contract as the persistence suite: no Docker required — without
 * `AUTHZ_TEST_PG_URL` the suite skips, and CI (which sets the URL plus
 * `AUTHZ_REQUIRE_PG_TESTS=1`) guarantees it runs. The graceful-SIGTERM
 * assertion assumes POSIX signal delivery (CI runs Linux).
 */

const CONNECTION = process.env["AUTHZ_TEST_PG_URL"];
const REQUIRE_PG = process.env["AUTHZ_REQUIRE_PG_TESTS"] === "1";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function reachable(url: string): Promise<boolean> {
  const db = createPgQueryable({ connectionString: url, max: 2 });
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await db.end();
  }
}

const available = CONNECTION !== undefined && (await reachable(CONNECTION));
if (REQUIRE_PG && !available) {
  throw new Error(
    "AUTHZ_REQUIRE_PG_TESTS=1 is set (e.g. in CI), but PostgreSQL is unreachable at AUTHZ_TEST_PG_URL. Aborting so tests do not silently skip.",
  );
}
const skipReason = available
  ? false
  : "set AUTHZ_TEST_PG_URL to run the data-plane PostgreSQL wiring suite (optional; Docker is not required)";

describe.skipIf(!available)("data-plane entrypoint with PostgreSQL", () => {
  let db: (PgQueryable & { end(): Promise<void> }) | null = null;
  let dir: string | null = null;
  let version = "";

  beforeAll(async () => {
    // The entrypoint loads ../dist/index.js — a fresh clone may not have it yet.
    if (!existsSync(join(REPO_ROOT, "packages/data-plane/dist/index.js"))) {
      execSync("pnpm --filter @uae/data-plane run build", { cwd: REPO_ROOT, stdio: "pipe" });
    }
    db = createPgQueryable({ connectionString: CONNECTION as string, max: 4 });
    await runMigrations(db);
    const writer = new PostgresRelationshipWriter(db);
    await writer.add({
      subject: "user:pg_member",
      relation: "member",
      resource: "organization:pg_org",
    });
    const store = new InMemoryPolicyStore();
    const versioned = await store.publishPolicy({ source: ACME_POLICY });
    version = versioned.version;
    dir = await mkdtemp(join(tmpdir(), "uae-dp-pg-"));
    await writeFile(join(dir, "artifact.json"), JSON.stringify(versioned));
  }, 60_000);

  afterAll(async () => {
    if (db !== null) await db.end();
    if (dir !== null) await rm(dir, { recursive: true, force: true });
  });

  it(
    "serves PostgreSQL-backed relationships, reports the version, and exits cleanly",
    { timeout: 45_000 },
    async () => {
      const port = 4300 + (process.pid % 400);
      const proc = spawn(process.execPath, ["packages/data-plane/bin/start.js"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          UAE_API_KEYS: "pg-wiring-key",
          UAE_ARTIFACT_PATH: join(dir as string, "artifact.json"),
          UAE_PG_URL: CONNECTION as string,
          UAE_RUN_MIGRATIONS: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let logs = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        logs += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        logs += chunk.toString();
      });

      const base = `http://127.0.0.1:${String(port)}`;
      try {
        let booted = false;
        for (let i = 0; i < 150 && !booted; i++) {
          try {
            const res = await fetch(`${base}/healthz`);
            if (res.ok) booted = true;
          } catch {
            /* not listening yet */
          }
          if (!booted) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(booted, `entrypoint never became healthy:\n${logs}`).toBe(true);

        // A relationship stored in PostgreSQL — impossible for the empty
        // in-memory store to produce, so `allowed` proves the wiring.
        const res = await fetch(`${base}/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": "pg-wiring-key" },
          body: JSON.stringify({
            subject: "user:pg_member",
            action: "organization.read",
            resource: "organization:pg_org",
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          outcome: string;
          decision: { allowed: boolean };
        };
        expect(body.outcome).toBe("decision");
        expect(body.decision.allowed).toBe(true);

        const versionRes = await fetch(`${base}/version`, {
          headers: { "X-API-Key": "pg-wiring-key" },
        });
        expect(versionRes.status).toBe(200);
        const versionBody = (await versionRes.json()) as { version: string };
        expect(versionBody.version).toBe(version);
      } finally {
        const exitCode = await new Promise<number>((resolve) => {
          if (proc.exitCode !== null) {
            resolve(proc.exitCode);
            return;
          }
          proc.once("exit", (code) => {
            resolve(code ?? -1);
          });
          proc.kill("SIGTERM");
        });
        expect(exitCode, `unclean shutdown:\n${logs}`).toBe(0);
      }
    },
  );
});

describe("data-plane PostgreSQL availability", () => {
  it.skipIf(available)("documents how to enable the wiring suite", () => {
    expect(skipReason).toContain("AUTHZ_TEST_PG_URL");
  });
  it.skipIf(!available)("connected using AUTHZ_TEST_PG_URL", () => {
    expect(CONNECTION).toBeDefined();
  });
});
