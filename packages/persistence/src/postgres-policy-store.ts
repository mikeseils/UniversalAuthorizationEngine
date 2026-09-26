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
 */
export class PostgresPolicyStore implements PolicyStore {
  private readonly db: PgQueryable;
  private readonly environment: string;
  private readonly compiler: InMemoryPolicyStore;
  private nextVersion = 1;
  private activeVersion: string | null = null;
  private pendingActivation: string | null = null;

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
   * evaluates.
   */
  async publishPolicy(policy: PolicySource): Promise<VersionedPolicy> {
    const compiled = await this.compiler.publishPolicy(policy);
    // Defensive: never persist an artifact the evaluator could not load.
    if (!isCompiledArtifactShape(compiled.artifact)) {
      throw new PolicyStoreError("refusing to persist a defective policy artifact");
    }
    const version = String(this.nextVersion);
    this.nextVersion += 1;
    const warnings = compiled.warnings ?? [];
    try {
      await this.db.query(
        `INSERT INTO policies (version, hash, artifact, warnings)
         VALUES ($1, $2, $3::jsonb, $4::jsonb)
         ON CONFLICT (version) DO NOTHING`,
        [version, compiled.hash, JSON.stringify(compiled.artifact), JSON.stringify(warnings)],
      );
    } catch (error) {
      throw persistenceError("publishPolicy", error);
    }
    return Object.freeze({
      version,
      hash: compiled.hash,
      artifact: compiled.artifact,
      ...(warnings.length === 0 ? {} : { warnings: Object.freeze([...warnings]) }),
    });
  }

  /**
   * Explicitly activate a published version (deployment act).
   *
   * Synchronous by design: the conformance contract requires an unknown version
   * to throw immediately, and activation is a control-plane call whose failure
   * must be loud rather than silently queued. The write is committed by
   * {@link activate}, which callers await.
   */
  setActiveVersion(version: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(version)) {
      throw new PolicyStoreError(`invalid policy version "${version}"`);
    }
    this.pendingActivation = version;
  }

  getActiveVersion(): string | null {
    return this.activeVersion;
  }

  /** Commit a pending activation. Call after {@link setActiveVersion}. */
  async activate(): Promise<void> {
    const version = this.pendingActivation;
    if (version === null) return;
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
    this.activeVersion = version;
    this.pendingActivation = null;
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
