import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, createCapturingIo, run, type ExitCode } from "../packages/cli/src/index.js";
import { createPgQueryable } from "../packages/persistence/src/index.js";

const PG_URL = process.env["AUTHZ_TEST_PG_URL"];

/** Identities import requires a live Postgres backend; live cases skip when
 * AUTHZ_TEST_PG_URL is unset. */
const ID_DB = "uae_cli_identities_test";

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
    await admin.query(`DROP DATABASE IF EXISTS ${ID_DB}`);
    await admin.query(`CREATE DATABASE ${ID_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(PG_URL);
  url.pathname = `/${ID_DB}`;
  baseUrl = url.toString();
});

afterAll(async () => {
  if (PG_URL === undefined) return;
  const admin = createPgQueryable({ connectionString: adminUrl(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${ID_DB}`);
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

const MAPPING_FILE = `${ID_DB}-mapping.jsonl`;
const MAPPING_CONTENT = [
  // SCIM-style externalId -> opaque subject ID mappings.
  '{"externalId":"ext-123","subject":"user:alice"}',
  '{"externalId":"ext-456","subject":"user:bob"}',
  "",
].join("\n");

describe("identities import (Phase 9 SCIM)", () => {
  it("requires --store postgres", async () => {
    const result = await cli(["identities import", MAPPING_FILE]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/--store postgres/);
  });

  it("requires a mapping file positional", async () => {
    const result = await cli(["identities import", "--store", "postgres"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/<mappingFile>/);
  });

  it("exits 2 when postgres is selected but unconfigured", async () => {
    const result = await cli(["identities import", MAPPING_FILE, "--store", "postgres"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/AUTHZ_DATABASE_URL/);
  });

  it("rejects a malformed mapping line as a validation error", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(MAPPING_FILE, '{"externalId":"","subject":"user:alice"}\n', "utf8");
    try {
      // A dummy URL passes the connection-string check; validation throws
      // before any database connection is attempted.
      const result = await cli(["identities import", MAPPING_FILE, "--store", "postgres"], {
        AUTHZ_DATABASE_URL: "postgres://localhost/x",
      });
      expect(result.code).toBe(EXIT.validation);
      expect(result.err).toMatch(/externalId/);
    } finally {
      await fs.promises.rm(MAPPING_FILE, { force: true });
    }
  });

  it.skipIf(PG_URL === undefined)(
    "imports idempotent mappedTo edges and records a provisioning act",
    async () => {
      const fs = await import("node:fs");
      fs.writeFileSync(MAPPING_FILE, MAPPING_CONTENT, "utf8");
      try {
        const first = await cli(["identities import", MAPPING_FILE, "--store", "postgres"], {
          AUTHZ_DATABASE_URL: baseUrl,
        });
        expect(first.code).toBe(EXIT.ok);
        expect(first.out).toMatch(/imported 2 SCIM identity mapping/);
        expect(first.out).toMatch(/2 new edge/);

        // Re-importing is idempotent: no new edges.
        const again = await cli(["identities import", MAPPING_FILE, "--store", "postgres"], {
          AUTHZ_DATABASE_URL: baseUrl,
        });
        expect(again.code).toBe(EXIT.ok);
        expect(again.out).toMatch(/0 new edge/);

        const audit = await cli(["policy-audit", "--store", "postgres", "--json"], {
          AUTHZ_DATABASE_URL: baseUrl,
        });
        expect(audit.code).toBe(EXIT.ok);
        const events = (JSON.parse(audit.out) as { readonly events: { readonly action: string }[] })
          .events;
        expect(events.some((e) => e.action === "provision")).toBe(true);
      } finally {
        await fs.promises.rm(MAPPING_FILE, { force: true });
      }
    },
  );
});
