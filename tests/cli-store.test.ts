import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXIT,
  STORE_BACKENDS,
  STORE_ENV,
  requireConnectionString,
  resolveStoreBackend,
} from "../packages/cli/src/index.js";
import { ACME_DIR, ACME_POLICY, ACME_RELATIONSHIPS, cli } from "./cli-helpers.js";
import { createPgQueryable } from "../packages/persistence/src/index.js";

/**
 * `authz check --store postgres` (Phase 6).
 *
 * The in-memory default is unchanged, and the two failure modes that matter are
 * both covered: asking for a database that is not configured must be a *usage*
 * error, never a silent fall back to an empty in-memory store — which would
 * report a confident DENY that actually means "no data was loaded".
 *
 * Live-database cases skip when `AUTHZ_TEST_PG_URL` is unset, so the default
 * developer workflow stays Docker-free. CI sets that variable and additionally
 * requires the Postgres suites, so the skip can never hide a regression there.
 */

const PG_URL = process.env["AUTHZ_TEST_PG_URL"];

/**
 * A database of this suite's own, so it cannot collide with other suites.
 *
 * Vitest runs test files in parallel, and `persistence-postgres.test.ts`
 * truncates `relationships` between its cases. Sharing one database would make
 * the two files delete each other's rows mid-test — producing a flaky DENY here
 * and a phantom extra row there, neither of which points at the real cause.
 * A separate database is the same isolation a real deployment has.
 */
const CLI_DB = "uae_cli_store_test";

function adminUrl(): string {
  const url = new URL(PG_URL as string);
  url.pathname = "/postgres";
  return url.toString();
}

let baseUrl: string | undefined;

beforeAll(async () => {
  if (PG_URL === undefined) return;
  const admin = createPgQueryable({ connectionString: adminUrl(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${CLI_DB}`);
    await admin.query(`CREATE DATABASE ${CLI_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(PG_URL);
  url.pathname = `/${CLI_DB}`;
  baseUrl = url.toString();
});

afterAll(async () => {
  if (PG_URL === undefined) return;
  const admin = createPgQueryable({ connectionString: adminUrl(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${CLI_DB}`);
  } finally {
    await admin.end();
  }
});

/** The Acme request answered identically by either backend. */
const CHECK_ARGS = [
  "check",
  "user:alice",
  "document.read",
  "document:a",
  "--policy",
  ACME_POLICY,
  "--relationships",
  ACME_RELATIONSHIPS,
  "--json",
] as const;

describe("store backend resolution (Phase 6)", () => {
  it("defaults to in-memory, so a fresh clone needs no database", () => {
    expect(resolveStoreBackend(undefined, {})).toBe("memory");
    expect(resolveStoreBackend(undefined, { [STORE_ENV]: "" })).toBe("memory");
  });

  it("reads AUTHZ_STORE when no flag is passed", () => {
    expect(resolveStoreBackend(undefined, { [STORE_ENV]: "postgres" })).toBe("postgres");
  });

  it("lets an explicit flag win over the environment", () => {
    expect(resolveStoreBackend("memory", { [STORE_ENV]: "postgres" })).toBe("memory");
    expect(resolveStoreBackend("postgres", {})).toBe("postgres");
  });

  it("rejects an unknown backend instead of falling back to memory", () => {
    // Falling back is the dangerous direction: the user asked for a database and
    // would get a decision computed from an empty store, which reads as a DENY.
    expect(() => resolveStoreBackend("mysql", {})).toThrow(/unknown store/);
    expect(() => resolveStoreBackend(undefined, { [STORE_ENV]: "sqlite" })).toThrow(
      /unknown store/,
    );
  });

  it("exposes exactly the two documented backends", () => {
    expect([...STORE_BACKENDS]).toEqual(["memory", "postgres"]);
  });

  it("requires a connection string for postgres rather than defaulting to localhost", () => {
    // Inventing `localhost` would surface as "connection refused", which an
    // operator reads as the database being down rather than as a misconfiguration.
    expect(() => requireConnectionString({})).toThrow(/AUTHZ_DATABASE_URL/);
    expect(requireConnectionString({ AUTHZ_DATABASE_URL: "postgres://x/y" })).toBe(
      "postgres://x/y",
    );
  });
});

describe("authz check --store (Phase 6)", () => {
  it("evaluates against in-memory by default, unchanged", async () => {
    const result = await cli([...CHECK_ARGS], { cwd: ACME_DIR });
    expect(result.code).toBe(EXIT.ok);
    expect(result.json["ok"]).toBe(true);
  });

  it("exits 2 with a clear message when postgres is selected but unconfigured", async () => {
    const result = await cli([...CHECK_ARGS, "--store", "postgres"], { cwd: ACME_DIR });
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/AUTHZ_DATABASE_URL/);
  });

  it("exits 2 on an unknown --store value", async () => {
    const result = await cli([...CHECK_ARGS, "--store", "cassandra"], { cwd: ACME_DIR });
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/unknown store/);
  });

  it.skipIf(PG_URL === undefined)(
    "agrees with the in-memory decision when answering from PostgreSQL",
    async () => {
      // The point of the store contract (ADR-0018) is that a backend is correct
      // because it passes the same specification. The same request must produce
      // the same answer whether it is read from memory or from Postgres.
      const remote = await cli([...CHECK_ARGS, "--store", "postgres"], {
        cwd: ACME_DIR,
        env: { AUTHZ_DATABASE_URL: baseUrl },
      });
      const local = await cli(CHECK_ARGS, { cwd: ACME_DIR });

      expect(remote.code).toBe(local.code);
      expect(remote.json["ok"]).toBe(local.json["ok"]);
    },
  );

  it.skipIf(PG_URL === undefined)("accepts AUTHZ_STORE instead of the flag", async () => {
    const viaEnv = await cli(CHECK_ARGS, {
      cwd: ACME_DIR,
      env: { AUTHZ_STORE: "postgres", AUTHZ_DATABASE_URL: baseUrl },
    });
    const viaFlag = await cli([...CHECK_ARGS, "--store", "postgres"], {
      cwd: ACME_DIR,
      env: { AUTHZ_DATABASE_URL: baseUrl },
    });
    expect(viaEnv.code).toBe(viaFlag.code);
    expect(viaEnv.json["ok"]).toBe(viaFlag.json["ok"]);
  });

  it.skipIf(PG_URL === undefined)("returns promptly, proving the pool is released", async () => {
    // A leaked pool keeps the event loop alive after the decision is printed,
    // which is indistinguishable from a hung CLI. Asserting the run() promise
    // settles quickly is the observable form of "the pool was closed".
    const started = Date.now();
    const result = await cli([...CHECK_ARGS, "--store", "postgres"], {
      cwd: ACME_DIR,
      env: { AUTHZ_DATABASE_URL: baseUrl },
    });
    expect(result.code).toBe(EXIT.ok);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
