import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, createCapturingIo, run, type ExitCode } from "../packages/cli/src/index.js";
import { createPgQueryable } from "../packages/persistence/src/index.js";

const PG_URL = process.env["AUTHZ_TEST_PG_URL"];

/** Compliance export requires a live Postgres backend; live cases skip when
 * AUTHZ_TEST_PG_URL is unset. */
const COMP_DB = "uae_cli_compliance_test";

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
    await admin.query(`DROP DATABASE IF EXISTS ${COMP_DB}`);
    await admin.query(`CREATE DATABASE ${COMP_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(PG_URL);
  url.pathname = `/${COMP_DB}`;
  baseUrl = url.toString();
});

afterAll(async () => {
  if (PG_URL === undefined) return;
  const admin = createPgQueryable({ connectionString: adminUrl(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${COMP_DB}`);
  } finally {
    await admin.end();
  }
});

async function cli(
  argv: readonly string[],
  env?: Record<string, string | undefined>,
): Promise<{
  code: ExitCode;
  out: string;
  err: string;
}> {
  const io = createCapturingIo(env === undefined ? {} : { env });
  const code = await run(argv, io);
  return { code, out: io.output.join("\n"), err: io.errors.join("\n") };
}

describe("compliance export (Phase 9)", () => {
  it("requires --store postgres", async () => {
    const result = await cli(["compliance export"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/--store postgres/);
  });

  it("exits 2 when postgres is selected but unconfigured", async () => {
    const result = await cli(["compliance export", "--store", "postgres"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/AUTHZ_DATABASE_URL/);
  });

  it.skipIf(PG_URL === undefined)(
    "emits NDJSON compliance evidence: active version + governance events",
    async () => {
      // No governance events yet: active version is null, events is empty.
      const empty = await cli(["compliance export", "--store", "postgres", "--json"], {
        AUTHZ_DATABASE_URL: baseUrl,
      });
      expect(empty.code).toBe(EXIT.ok);
      const body = JSON.parse(empty.out);
      expect(body.environment).toBe("default");
      expect(body.activePolicyVersion).toBeNull();
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events).toHaveLength(0);

      // Human-readable output should not leak secrets.
      const human = await cli(["compliance export", "--store", "postgres"], {
        AUTHZ_DATABASE_URL: baseUrl,
      });
      expect(human.code).toBe(EXIT.ok);
      expect(human.err).toBe("");
      expect(human.out).toMatch(/compliance export/);
      expect(human.out).not.toMatch(/Bearer|api.?key|secret/i);
    },
  );

  it.skipIf(PG_URL === undefined)("filters events by --since timestamp", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const filtered = await cli(
      ["compliance export", "--store", "postgres", "--since", future, "--json"],
      { AUTHZ_DATABASE_URL: baseUrl },
    );
    expect(filtered.code).toBe(EXIT.ok);
    const body = JSON.parse(filtered.out);
    expect(body.since).toBe(future);
    expect(body.events).toHaveLength(0);
  });
});
