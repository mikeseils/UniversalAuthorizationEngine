import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, createCapturingIo, run, type ExitCode } from "../packages/cli/src/index.js";
import { createPgQueryable } from "../packages/persistence/src/index.js";

const PG_URL = process.env["AUTHZ_TEST_PG_URL"];

/** Governance commands require a live Postgres backend, so live cases skip
 * when AUTHZ_TEST_PG_URL is unset (default workflow stays Docker-free). */
const GOV_DB = "uae_cli_governance_test";

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
    await admin.query(`DROP DATABASE IF EXISTS ${GOV_DB}`);
    await admin.query(`CREATE DATABASE ${GOV_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(PG_URL);
  url.pathname = `/${GOV_DB}`;
  baseUrl = url.toString();
});

afterAll(async () => {
  if (PG_URL === undefined) return;
  const admin = createPgQueryable({ connectionString: adminUrl(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${GOV_DB}`);
  } finally {
    await admin.end();
  }
});

/** Run the CLI in-process and capture everything it wrote. */
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

const ACME_POLICY = [
  "definition organization {",
  "  relation admin: user",
  "  permission manage = admin",
  "}",
  "",
].join("\n");

const V2_POLICY = [
  "definition organization {",
  "  relation admin: user",
  "  relation member: user",
  "  permission manage = admin",
  "  permission read = admin or member",
  "}",
  "",
].join("\n");

/** Shape of the NDJSON body emitted by `authz policy-audit --json`. */
interface AuditBody {
  readonly environment: string;
  readonly events: { readonly action: string; readonly version: string }[];
}

describe("policy-publish (Phase 9 governance)", () => {
  it("requires --store postgres", async () => {
    const result = await cli(["policy-publish", "policy.authz"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/--store postgres/);
  });

  it("exits 2 when postgres is selected but unconfigured", async () => {
    const result = await cli(["policy-publish", "policy.authz", "--store", "postgres"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/AUTHZ_DATABASE_URL/);
  });

  it.skipIf(PG_URL === undefined)(
    "publishes a version, activates it, and records the publish act",
    async () => {
      await import("node:fs").then((fs) => {
        fs.writeFileSync(`${GOV_DB}-policy.authz`, ACME_POLICY, "utf8");
      });
      try {
        const published = await cli(
          ["policy-publish", `${GOV_DB}-policy.authz`, "--store", "postgres"],
          {
            AUTHZ_DATABASE_URL: baseUrl,
          },
        );
        expect(published.code).toBe(EXIT.ok);
        expect(published.out).toContain("published policy version");

        const activated = await cli(["policy-activate", "1", "--store", "postgres"], {
          AUTHZ_DATABASE_URL: baseUrl,
        });
        expect(activated.code).toBe(EXIT.ok);
        expect(activated.out).toContain("activated policy version 1");

        const audit = await cli(["policy-audit", "--store", "postgres", "--json"], {
          AUTHZ_DATABASE_URL: baseUrl,
        });
        expect(audit.code).toBe(EXIT.ok);
        const events = (JSON.parse(audit.out) as AuditBody).events;
        const actions = events.map((e) => e.action);
        expect(actions).toContain("publish");
        expect(actions).toContain("activate");
        expect(events.some((e) => e.version === "1")).toBe(true);
      } finally {
        await import("node:fs").then((fs) => {
          fs.rmSync(`${GOV_DB}-policy.authz`, { force: true });
        });
      }
    },
  );
});

describe("policy-activate (Phase 9 governance)", () => {
  it("requires --store postgres", async () => {
    const result = await cli(["policy-activate", "1"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/--store postgres/);
  });

  it("rejects a malformed version as a validation error", async () => {
    const result = await cli(["policy-activate", "not.a;valid-version"], { "--store": "postgres" });
    expect(result.code).toBe(EXIT.validation);
  });

  it.skipIf(PG_URL === undefined)(
    "activates an existing version and records the activate act",
    async () => {
      await cli(["policy-publish", `${GOV_DB}-policy.authz`, "--store", "postgres"], {
        AUTHZ_DATABASE_URL: baseUrl,
      });
      await import("node:fs").then((fs) => {
        fs.writeFileSync(`${GOV_DB}-v2.authz`, V2_POLICY, "utf8");
      });
      try {
        const published = await cli(
          ["policy-publish", `${GOV_DB}-v2.authz`, "--store", "postgres"],
          { AUTHZ_DATABASE_URL: baseUrl },
        );
        expect(published.code).toBe(EXIT.ok);

        const result = await cli(["policy-activate", "2", "--store", "postgres"], {
          AUTHZ_DATABASE_URL: baseUrl,
        });
        expect(result.code).toBe(EXIT.ok);
        expect(result.out).toContain("activated policy version 2");
      } finally {
        await import("node:fs").then((fs) => {
          fs.rmSync(`${GOV_DB}-v2.authz`, { force: true });
        });
      }
    },
  );
});

describe("policy-audit (Phase 9 governance)", () => {
  it("requires --store postgres", async () => {
    const result = await cli(["policy-audit"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/--store postgres/);
  });

  it.skipIf(PG_URL === undefined)(
    "lists governance events in reverse chronological order",
    async () => {
      await cli(["policy-publish", `${GOV_DB}-policy.authz`, "--store", "postgres"], {
        AUTHZ_DATABASE_URL: baseUrl,
      });
      const audit = await cli(["policy-audit", "--store", "postgres", "--json"], {
        AUTHZ_DATABASE_URL: baseUrl,
      });
      expect(audit.code).toBe(EXIT.ok);
      const body = JSON.parse(audit.out) as AuditBody;
      expect(body.environment).toBe("default");
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBeGreaterThanOrEqual(1);
    },
  );
});
