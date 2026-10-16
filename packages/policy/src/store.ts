import { PolicySource, PolicyStore, VersionedPolicy } from "@uae/core";
import { CompiledPolicy, compileStructuredPolicy, isCompiledArtifactShape } from "./compile.js";
import { PolicyLoweringError } from "./lower.js";
import { PolicySyntaxError } from "./lexer.js";
import { compilePolicySource } from "./source.js";
import { StructuredPolicy } from "./structured-policy.js";
import { PolicyValidationError, validateStructuredPolicy } from "./validate.js";
import { signArtifact } from "./signing.js";

/** Typed infrastructure error (distinct from a DENY — ADR-0010). */
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
 * Optional publishing options for `InMemoryPolicyStore.publishPolicy`.
 * When `signingKey` is provided, the published artifact is signed (ADR-0024)
 * and the returned `VersionedPolicy` carries `signature`, `keyId`, and
 * `algorithm`. When absent, publishing is unchanged and produces an unsigned
 * artifact (the development default).
 */
export interface PublishOptions {
  /** PEM-encoded Ed25519 private key (PKCS#8). */
  readonly signingKey?: string;
  /** Key identifier (kid) used to verify the signature; defaults to `"default"`. */
  readonly keyId?: string;
}

interface PublishablePolicy extends CompiledPolicy {
  readonly warnings: readonly string[];
}

/** Authoring failures share one typed error at the publish boundary. */
function asAuthoringError(error: unknown): never {
  if (
    error instanceof PolicySyntaxError ||
    error instanceof PolicyLoweringError ||
    error instanceof PolicyValidationError
  ) {
    throw policyError(error.message);
  }
  throw error;
}

/**
 * Resolve a `PolicySource` to a validated, compiled policy. Format is explicit
 * when provided, otherwise inferred: a string is text, anything else is
 * structured (ADR-0012) — so both authoring styles reach the same publish path.
 */
function resolvePolicy(policy: PolicySource): PublishablePolicy {
  const format = policy.format ?? (typeof policy.source === "string" ? "text" : "structured");
  if (format === "text") {
    if (typeof policy.source !== "string") {
      throw policyError("policy source declared as text but is not a string");
    }
    try {
      return compilePolicySource(policy.source);
    } catch (error) {
      asAuthoringError(error);
    }
  }
  if (typeof policy.source === "string") {
    throw policyError("policy source declared as structured but is a string");
  }
  const validation = validateStructuredPolicy(policy.source);
  if (!validation.valid) {
    throw policyError(`policy rejected: ${validation.errors.join("; ")}`);
  }
  const { artifact, hash } = compileStructuredPolicy(policy.source as StructuredPolicy);
  return { artifact, hash, warnings: validation.warnings };
}

/**
 * In-memory, append-only policy store (Phase 2 implementation of the core
 * `PolicyStore` interface, docs/architecture/storage.md).
 *
 * - `publishPolicy` accepts policy text (ADR-0012) or a structured policy,
 *   validates + compiles it, and stores a new immutable version.
 * - Version activation is explicit (`setActiveVersion`) — activation is a
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

  publishPolicy(policy: PolicySource, options: PublishOptions = {}): Promise<VersionedPolicy> {
    let resolved: PublishablePolicy;
    try {
      resolved = resolvePolicy(policy);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new PolicyStoreError(String(error)));
    }
    if (!isCompiledArtifactShape(resolved.artifact)) {
      return Promise.reject(policyError("compiled artifact failed structural re-check"));
    }
    const version = String(this.nextVersionNumber);
    this.nextVersionNumber += 1;
    const versioned: VersionedPolicy = Object.freeze({
      version,
      hash: resolved.hash,
      artifact: resolved.artifact,
      ...(resolved.warnings.length === 0 ? {} : { warnings: resolved.warnings }),
      ...(options.signingKey === undefined
        ? {}
        : {
            signature: signArtifact(resolved.artifact, resolved.hash, options.signingKey, {
              ...(options.keyId === undefined ? {} : { keyId: options.keyId }),
            }).signature,
            keyId: options.keyId ?? "default",
            algorithm: "ed25519" as const,
          }),
    });
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

  /**
   * Load a pre-compiled `VersionedPolicy` directly (data-plane path).
   *
   * Unlike `publishPolicy`, this does not recompile or re-hash — the artifact
   * is stored exactly as provided. Used by the data plane to load signed
   * artifacts produced by the control plane (ADR-0007, ADR-0024).
   */
  loadVersion(versioned: VersionedPolicy): void {
    if (!isCompiledArtifactShape(versioned.artifact)) {
      throw new PolicyStoreError("compiled artifact failed structural re-check");
    }
    const frozen: VersionedPolicy = Object.freeze({
      version: versioned.version,
      hash: versioned.hash,
      artifact: versioned.artifact,
      ...(versioned.warnings === undefined ? {} : { warnings: versioned.warnings }),
      ...(versioned.signature === undefined ? {} : { signature: versioned.signature }),
      ...(versioned.keyId === undefined ? {} : { keyId: versioned.keyId }),
      ...(versioned.algorithm === undefined ? {} : { algorithm: versioned.algorithm }),
    });
    this.versions.set(frozen.version, frozen);
    if (this.activeVersion === null) {
      this.activeVersion = frozen.version;
    }
  }

  getActiveVersion(): string | null {
    return this.activeVersion;
  }

  /** Clear all versions and the active pointer (test isolation only). */
  reset(): Promise<void> {
    this.versions.clear();
    this.activeVersion = null;
    this.nextVersionNumber = 1;
    return Promise.resolve();
  }
}
