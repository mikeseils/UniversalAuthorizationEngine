import { readFileSync } from "node:fs";
import { ActivatablePolicyStore, Relationship } from "@uae/core";
import { Evaluator, InMemoryRelationshipStore } from "@uae/evaluator";
import {
  CompiledPolicySource,
  InMemoryPolicyStore,
  PolicyLoweringError,
  PolicySyntaxError,
  PolicyValidationError,
  compilePolicySource,
} from "@uae/policy";
import { reason } from "./config.js";
import { UsageError, ValidationFailure } from "./errors.js";
import { readRelationshipsFile } from "./relationships-file.js";

/**
 * Session wiring: policy file → compiled artifact → activated store, plus
 * relationship data → store, and an evaluator over both (ADR-0013).
 *
 * The CLI duplicates no engine logic: policy compilation, validation, storage,
 * and evaluation are the library's. Authoring failures (syntax/lowering/
 * validation) are reported as validation failures (exit 1); unreadable files and
 * malformed data files are usage failures (exit 2); everything else that throws
 * is an infrastructure failure (exit 4, mapped in `run`).
 */

export function readTextFile(file: string, what: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${what} ${file}: ${reason(error)}`);
  }
}

/** Compile policy text, mapping authoring errors to a validation failure. */
export function compilePolicyText(text: string): CompiledPolicySource {
  try {
    return compilePolicySource(text);
  } catch (error) {
    if (
      error instanceof PolicySyntaxError ||
      error instanceof PolicyLoweringError ||
      error instanceof PolicyValidationError
    ) {
      throw new ValidationFailure(error.message);
    }
    throw error;
  }
}

/** Read + compile a policy file (exit 2 if unreadable, exit 1 if invalid). */
export function compilePolicyFile(file: string): CompiledPolicySource {
  return compilePolicyText(readTextFile(file, "policy file"));
}

export interface SessionOptions {
  readonly policyFile: string;
  readonly relationshipsFile: string | null;
  /**
   * Evaluate against a live PostgreSQL database instead of in-memory stores
   * (ADR-0017). Omitted — the default — keeps the CLI Docker-free.
   */
  readonly postgres?: { readonly connectionString: string };
}

export interface Session {
  readonly evaluator: Evaluator;
  /**
   * The store holding the compiled policy, typed as the core *control-plane*
   * view, not the in-memory class: activation MAY be asynchronous (ADR-0018 S7
   * — a persistent backend reads the version row and commits the deployment
   * pointer), so every caller `await`s it, and the CLI must not depend on the
   * reference implementation (ADR-0005).
   */
  readonly policyStore: ActivatablePolicyStore;
  readonly policyVersion: string;
  readonly warnings: readonly string[];
  readonly policyFile: string;
  readonly relationshipsFile: string | null;
  /** Baseline relationships loaded from the data file, in file order. */
  readonly baseline: readonly Relationship[];
  /**
   * Release backend resources (the Postgres pool). Always call this, including
   * on the error path: an unclosed pool keeps the process alive after the
   * decision has been printed.
   */
  close(): Promise<void>;
}

/** A session whose close is a no-op, so callers need no backend branch. */
const NO_CLOSE = (): Promise<void> => Promise.resolve();

/** Build a ready-to-evaluate session from files on disk. */
export async function loadSession(options: SessionOptions): Promise<Session> {
  const compiled = compilePolicyFile(options.policyFile);
  const baseline = loadRelationships(options.relationshipsFile);

  if (options.postgres !== undefined) {
    return buildPostgresSession(compiled, baseline, options, options.postgres.connectionString);
  }

  const policyStore: ActivatablePolicyStore = new InMemoryPolicyStore();
  let version: string;
  try {
    const published = await policyStore.publishPolicy({ source: compiled.policy });
    await policyStore.setActiveVersion(published.version);
    version = published.version;
  } catch (error) {
    throw new ValidationFailure(reason(error));
  }

  const relationships = new InMemoryRelationshipStore();
  relationships.addAll(baseline);

  return {
    evaluator: new Evaluator({
      policyStore,
      relationshipStore: relationships.asRelationshipStore(),
    }),
    policyStore,
    policyVersion: version,
    warnings: compiled.warnings,
    policyFile: options.policyFile,
    relationshipsFile: options.relationshipsFile,
    baseline,
    close: NO_CLOSE,
  };
}

/**
 * Same policy, same data, but stored in PostgreSQL.
 *
 * Migrations run first so `authz check --store postgres` works against an empty
 * database. The compiled policy is published and activated exactly as in the
 * in-memory path, so a Postgres-backed check and a memory-backed check of the
 * same file are evaluating the same artifact — that parity is the point of
 * routing through the shared store contract (ADR-0018) rather than a
 * Postgres-specific shortcut.
 */
async function buildPostgresSession(
  compiled: CompiledPolicySource,
  baseline: readonly Relationship[],
  options: SessionOptions,
  connectionString: string,
): Promise<Session> {
  const {
    createPgQueryable,
    PostgresPolicyStore,
    PostgresRelationshipStore,
    PostgresRelationshipWriter,
    runMigrations,
  } = await import("@uae/persistence");
  const db = createPgQueryable({ connectionString });
  try {
    await runMigrations(db);

    const policyStore = new PostgresPolicyStore(db);
    const published = await policyStore.publishPolicy({ source: compiled.policy });
    await policyStore.setActiveVersion(published.version);

    // Batch insert: one transaction, so a partially seeded database is never
    // observable (ADR-0018 S5).
    if (baseline.length > 0) {
      await new PostgresRelationshipWriter(db).addBatch(baseline);
    }

    return {
      evaluator: new Evaluator({
        policyStore,
        relationshipStore: new PostgresRelationshipStore(db),
      }),
      policyStore,
      policyVersion: published.version,
      warnings: compiled.warnings,
      policyFile: options.policyFile,
      relationshipsFile: options.relationshipsFile,
      baseline,
      close: () => db.end(),
    };
  } catch (error) {
    // Never leave the pool open on a failed startup.
    await db.end();
    throw error;
  }
}

/** Load relationship data; null means "no relationships". */
export function loadRelationships(file: string | null): readonly Relationship[] {
  if (file === null) return [];
  const result = readRelationshipsFile(file);
  if (result.errors.length > 0) {
    throw new ValidationFailure(result.errors.join("\n"));
  }
  return result.relationships;
}

/** A fresh store seeded with a baseline, as used per policy test (ADR-0014). */
export function makeRelationshipStore(
  baseline: readonly Relationship[],
): InMemoryRelationshipStore {
  const store = new InMemoryRelationshipStore();
  store.addAll(baseline);
  return store;
}
