import { PolicySource, PolicyStore, VersionedPolicy } from "@uae/core";
import { InMemoryPolicyStore, PolicyStoreError, isCompiledArtifactShape } from "@uae/policy";
import { persistenceError } from "./errors.js";
import { PgQueryable, readJson } from "./pool.js";

/**
 * PostgreSQL `PolicyStore` (Phase 6, ADR-0017).
 *
 * Compilation and validation are **not** duplicated here: the in-memory
 * publisher remains the single implementation of "turn a `PolicySource` into a
 * validated, hashed, immutable artifact". This store delegates to it and only
 * handles persistence. One definition of a valid policy matters because a
 * second SQL-side validator would inevitably drift, and could accept an
 * artifact the evaluator later fails closed on.
 *
 * Activation (`setActiveVersion`) is async, unlike the in-memory store's sync
 * setter: rejecting an unknown version (S9) requires a database read, and
 * committing the deployment pointer requires a database write. Callers must
 * `await` it before reading the active policy back.
 */
export class PostgresPolicyStore implements PolicyStore {
  private readonly db: PgQueryable;
  readonly environment: string;
  private compiler: InMemoryPolicyStore;

  constructor(db: PgQueryable, options: { environment?: string } = {}) {
    this.db = db;
    this.environment = options.environment ?? "default";
    this.compiler = new InMemoryPolicyStore();
  }

  async getActivePolicy(): Promise<VersionedPolicy> {
    try {
      const result = await this.db.query<{ version: string }>(
        "SELECT version FROM policy_deployments WHERE environment = $1",
        [this.environment],
      );
      const row = result.rows[0];
      if (row === undefined) {
        // A missing active pointer is an error, never a null policy (S9):
        // silently evaluating "no policy" denies everything while looking healthy.
        throw new PolicyStoreError(`no active policy for environment "${this.environment}"`);
      }
      const policy = await this.getPolicyVersion(row.version);
      if (policy === null) {
        throw new PolicyStoreError(`active version "${row.version}" is missing from storage`);
      }
      return policy;
    } catch (error) {
      if (error instanceof PolicyStoreError) throw error;
      throw persistenceError("getActivePolicy", error);
    }
  }

  async getPolicyVersion(version: string): Promise<VersionedPolicy | null> {
    try {
      const result = await this.db.query<PolicyRow>(
        "SELECT version, hash, artifact, warnings FROM policies WHERE version = $1",
        [version],
      );
      const row = result.rows[0];
      return row === undefined ? null : toVersionedPolicy(row);
    } catch (error) {
      throw persistenceError("getPolicyVersion", error);
    }
  }

  /**
   * Validate, compile, and store a new immutable version.
   *
   * Publishing does **not** activate (ADR-0018 S7): activation is a separate,
   * explicit act, so publishing can never change what a running data plane
   * evaluates. Versions are allocated by the database sequence `policy_versions`
   * (ADR-0018 S8): every publish mints a distinct version even for identical
   * content, and distinct store instances sharing one database can never
   * collide on a per-instance counter. Validation happens BEFORE the sequence
   * advances: a malformed source is rejected and stores (and allocates)
   * nothing (S10), so a rejected source never consumes a version number.
   */
  async publishPolicy(policy: PolicySource): Promise<VersionedPolicy> {
    const versioned = await this.compiler.publishPolicy(policy);
    // Defensive: never persist an artifact the evaluator could not load.
    if (!isCompiledArtifactShape(versioned.artifact)) {
      throw new PolicyStoreError("refusing to persist a defective policy artifact");
    }
    const warnings = versioned.warnings ?? [];
    // The sequence is authoritative: the version is minted by this INSERT, so a
    // version row exists only if the statement succeeded. A failed insert may
    // leave a gap in the sequence, which is harmless — versions are opaque
    // identifiers, never counts — and two publishes of identical content can
    // never collapse onto one version (S8).
    const allocated = await this.db
      .query<{ version: string }>(
        `INSERT INTO policies (version, hash, artifact, warnings)
       VALUES (nextval('policy_versions')::text, $1, $2::jsonb, $3::jsonb)
       RETURNING version`,
        [versioned.hash, JSON.stringify(versioned.artifact), JSON.stringify(warnings)],
      )
      .catch((error: unknown) => {
        throw persistenceError("publishPolicy", error);
      });
    const version = allocated.rows[0]?.version;
    if (version === undefined) {
      throw persistenceError("publishPolicy", new Error("database returned no version"));
    }
    return Object.freeze({
      version,
      hash: versioned.hash,
      artifact: versioned.artifact,
      ...(warnings.length === 0 ? {} : { warnings: Object.freeze([...warnings]) }),
    });
  }

  /**
   * Explicitly activate a published version (deployment act) and commit it.
   *
   * The write is committed before returning: activation must be visible to a
   * fresh data-plane reader (a new store instance on a new connection) the
   * moment activation resolves. Unknown versions are rejected (S9).
   */
  async setActiveVersion(version: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(version)) {
      throw new PolicyStoreError(`invalid policy version "${version}"`);
    }
    const existing = await this.getPolicyVersion(version);
    if (existing === null) {
      throw new PolicyStoreError(`cannot activate unknown version "${version}"`);
    }
    try {
      await this.db.query(
        `INSERT INTO policy_deployments (environment, version)
         VALUES ($1, $2)
         ON CONFLICT (environment) DO UPDATE
           SET version = EXCLUDED.version, activated_at = now()`,
        [this.environment, version],
      );
    } catch (error) {
      throw persistenceError("activate", error);
    }
  }

  /** Read the active version pointer without loading the artifact. */
  async getActiveVersion(): Promise<string | null> {
    try {
      const result = await this.db.query<{ version: string }>(
        "SELECT version FROM policy_deployments WHERE environment = $1",
        [this.environment],
      );
      return result.rows[0]?.version ?? null;
    } catch (error) {
      throw persistenceError("getActiveVersion", error);
    }
  }

  /**
   * Test cleanup between conformance cases: clears policy state and the active
   * pointer, leaving the store indistinguishable from a freshly migrated one —
   * the same guarantee `InMemoryPolicyStore.reset()` makes.
   *
   * `policy_deployments` references `policies`, so both tables truncate in one
   * statement. `RESTART IDENTITY` is not sufficient for version allocation: it
   * restarts only sequences *owned* by the truncated tables, and
   * `policy_versions` is standalone (measured on PostgreSQL 18 — the
   * truncate leaves its `last_value` untouched). It is restarted explicitly, so
   * after a reset the next publish mints version `1`, exactly as a fresh
   * cluster would and exactly as the in-memory store's counter does.
   *
   * The local compiler holds no persisted state, but it is recreated so that a
   * reset store cannot differ from a new one in a way nothing would explain.
   */
  async reset(): Promise<void> {
    try {
      await this.db.query("TRUNCATE policy_deployments, policies RESTART IDENTITY");
      await this.db.query("ALTER SEQUENCE policy_versions RESTART WITH 1");
      this.compiler = new InMemoryPolicyStore();
    } catch (error) {
      throw persistenceError("reset", error);
    }
  }
}

interface PolicyRow {
  readonly version: string;
  readonly hash: string;
  readonly artifact: unknown;
  readonly warnings: unknown;
}

function toVersionedPolicy(row: PolicyRow): VersionedPolicy {
  const parsed = readJson(row.warnings);
  const list = Array.isArray(parsed)
    ? parsed.filter((w): w is string => typeof w === "string")
    : [];
  return Object.freeze({
    version: row.version,
    hash: row.hash,
    artifact: readJson(row.artifact),
    ...(list.length === 0 ? {} : { warnings: Object.freeze(list) }),
  });
}
