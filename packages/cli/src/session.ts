import { readFileSync } from "node:fs";
import { Relationship } from "@uae/core";
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
}

export interface Session {
  readonly evaluator: Evaluator;
  readonly policyStore: InMemoryPolicyStore;
  readonly policyVersion: string;
  readonly warnings: readonly string[];
  readonly policyFile: string;
  readonly relationshipsFile: string | null;
  /** Baseline relationships loaded from the data file, in file order. */
  readonly baseline: readonly Relationship[];
}

/** Build a ready-to-evaluate session from files on disk. */
export async function loadSession(options: SessionOptions): Promise<Session> {
  const compiled = compilePolicyFile(options.policyFile);
  const baseline = loadRelationships(options.relationshipsFile);

  const policyStore = new InMemoryPolicyStore();
  let version: string;
  try {
    const published = await policyStore.publishPolicy({ source: compiled.policy });
    policyStore.setActiveVersion(published.version);
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
  };
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
