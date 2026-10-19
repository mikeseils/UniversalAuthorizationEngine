/**
 * Store backend selection for the CLI (Phase 6, ADR-0017).
 *
 * `authz` runs in-memory by default and that default is unchanged: the CLI is
 * a local authoring tool, and a fresh clone must work with no database. A
 * persistent backend is opt-in, and it is opt-in *explicitly* — a flag or an
 * environment variable, never inferred from the presence of a config file. A
 * tool that silently started writing to a real database when a file happened to
 * exist would be a footgun with a data-loss failure mode.
 *
 * Precedence mirrors the rest of the CLI (ADR-0013): flag → environment.
 */

import { UsageError } from "./errors.js";

/** The backends `authz check` can evaluate against. */
export const STORE_BACKENDS = ["memory", "postgres"] as const;
export type StoreBackend = (typeof STORE_BACKENDS)[number];

/** Environment variable selecting the backend when no flag is passed. */
export const STORE_ENV = "AUTHZ_STORE";
/** Environment variable holding the PostgreSQL connection string. */
export const DATABASE_ENV = "AUTHZ_DATABASE_URL";
/** Environment variable selecting the governance environment (default `default`). */
export const ENVIRONMENT_ENV = "UAE_ENVIRONMENT";
/** Environment variable naming the actor for governance audit records (default `operator`). */
export const GOVERNANCE_ACTOR_ENV = "UAE_GOVERNANCE_ACTOR";

/**
 * Resolve the backend from an explicit flag, then `AUTHZ_STORE`, then the
 * in-memory default.
 *
 * An unrecognised value is a usage error rather than a silent fallback to
 * memory. Falling back would be the dangerous direction: the user asked for a
 * database and would get a decision computed from an empty in-memory store,
 * which reads as a legitimate DENY.
 */
export function resolveStoreBackend(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): StoreBackend {
  const raw = flag ?? env[STORE_ENV];
  if (raw === undefined || raw === "") return "memory";
  const match = STORE_BACKENDS.find((backend) => backend === raw);
  if (match === undefined) {
    throw new UsageError(
      `unknown store "${raw}": expected one of ${STORE_BACKENDS.join(", ")}` +
        ` (or set ${STORE_ENV})`,
    );
  }
  return match;
}

/**
 * The connection string for the Postgres backend.
 *
 * Missing here is a usage error, not a default: there is no sensible fallback
 * database, and inventing one (`localhost`) would produce a connection refused
 * that looks like the engine being down.
 */
export function requireConnectionString(env: Readonly<Record<string, string | undefined>>): string {
  const url = env[DATABASE_ENV];
  if (url === undefined || url === "") {
    throw new UsageError(
      `--store postgres requires ${DATABASE_ENV} (a PostgreSQL connection string)`,
    );
  }
  return url;
}
