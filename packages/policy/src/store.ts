import { PolicySource, PolicyStore, VersionedPolicy } from "@uae/core";
import { compileStructuredPolicy, isCompiledArtifactShape } from "./compile.js";
import { StructuredPolicy } from "./structured-policy.js";
import { validateStructuredPolicy } from "./validate.js";

/** Typed infrastructure error (distinct from a DENY â€” ADR-0010). */
export class PolicyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyStoreError";
  }
}

function policyError(message: string): PolicyStoreError {
  return new PolicyStoreError(message);
}

/**
 * In-memory, append-only policy store (Phase 2 implementation of the core
 * `PolicyStore` interface, docs/architecture/storage.md).
 *
 * - `publishPolicy` validates + compiles and stores a new immutable version.
 * - Version activation is explicit (`setActiveVersion`) â€” activation is a
 *   deliberate deployment act, never a side effect of publishing.
 */
export class InMemoryPolicyStore implements PolicyStore {
  private readonly versions = new Map<string, VersionedPolicy>();
  private activeVersion: string | null = null;
  private nextVersionNumber = 1;

  getActivePolicy(): Promise<VersionedPolicy> {
    if (this.activeVersion === null) return Promise.reject(policyError("no active policy version"));
    const policy = this.versions.get(this.activeVersion);
    if (policy === undefined) {
      return Promise.reject(policyError(`active version "${this.activeVersion}" is missing`));
    }
    return Promise.resolve(policy);
  }

  getPolicyVersion(version: string): Promise<VersionedPolicy | null> {
    return Promise.resolve(this.versions.get(version) ?? null);
  }

  publishPolicy(policy: PolicySource): Promise<VersionedPolicy> {
    const validation = validateStructuredPolicy(policy.source);
    if (!validation.valid) {
      return Promise.reject(policyError(`policy rejected: ${validation.errors.join("; ")}`));
    }
    const version = String(this.nextVersionNumber);
    this.nextVersionNumber += 1;
    const { artifact, hash } = compileStructuredPolicy(policy.source as StructuredPolicy);
    if (!isCompiledArtifactShape(artifact)) {
      return Promise.reject(policyError("compiled artifact failed structural re-check"));
    }
    const versioned: VersionedPolicy = Object.freeze({ version, hash, artifact });
    this.versions.set(version, versioned);
    return Promise.resolve(versioned);
  }

  /** Explicitly activate a published version (deployment act). */
  setActiveVersion(version: string): void {
    if (!this.versions.has(version)) {
      throw new PolicyStoreError(`cannot activate unknown version "${version}"`);
    }
    this.activeVersion = version;
  }

  getActiveVersion(): string | null {
    return this.activeVersion;
  }
}
