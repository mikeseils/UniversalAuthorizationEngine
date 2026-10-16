import { readFile } from "node:fs/promises";
import { InMemoryPolicyStore } from "@uae/policy";
import { type CompiledPolicyArtifact } from "@uae/policy";
import { type VersionedPolicy } from "@uae/core";
import { verifyArtifact } from "@uae/policy";

/**
 * Configuration for loading a policy artifact into the data plane.
 *
 * The artifact is loaded from a file (JSON) and, when it carries a signature,
 * verified against configured public keys before being served for evaluation.
 * This is the data-plane side of the ADR-0007 trust boundary: a compromised
 * control plane cannot push an unverifiable artifact to a verifying data plane.
 */
export interface ArtifactLoaderOptions {
  /** Path to a JSON file containing a VersionedPolicy (or CompiledPolicy). */
  readonly artifactPath: string;
  /** Map of `keyId → PEM public key` for signature verification. */
  readonly publicKeys: Record<string, string>;
  /** When true, unsigned artifacts are rejected (fail-closed). Default: false. */
  readonly requireSignature?: boolean;
}

/**
 * Load a policy artifact from disk and optionally verify its signature.
 *
 * Returns a `VersionedPolicy` ready for the evaluator. Throws if the artifact
 * cannot be loaded, is malformed, or fails signature verification.
 */
export class ArtifactLoader {
  private readonly store: InMemoryPolicyStore;
  private readonly artifactPath: string;
  private readonly publicKeys: Record<string, string>;
  private readonly requireSignature: boolean;

  constructor(options: ArtifactLoaderOptions) {
    this.store = new InMemoryPolicyStore();
    this.artifactPath = options.artifactPath;
    this.publicKeys = options.publicKeys;
    this.requireSignature = options.requireSignature ?? false;
  }

  /** Load and verify the artifact, then activate it. */
  async load(): Promise<void> {
    const raw = await readFile(this.artifactPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `invalid policy artifact JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const versioned = this.parseArtifact(parsed);
    this.store.loadVersion(versioned);
    this.store.setActiveVersion(versioned.version);
  }

  /** Get the loaded store (evaluator consumes this). */
  get policyStore(): InMemoryPolicyStore {
    return this.store;
  }

  private parseArtifact(parsed: unknown): VersionedPolicy {
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("policy artifact must be a JSON object");
    }
    const obj = parsed as Record<string, unknown>;
    const version = obj["version"];
    const hash = obj["hash"];
    const artifact = obj["artifact"];
    const signature = obj["signature"];
    const keyId = obj["keyId"];
    const algorithm = obj["algorithm"];

    if (typeof version !== "string") throw new Error("policy artifact missing version");
    if (typeof hash !== "string") throw new Error("policy artifact missing hash");
    if (artifact === null || typeof artifact !== "object") {
      throw new Error("policy artifact missing artifact");
    }

    // Signature verification when the artifact carries a signature.
    if (signature !== undefined && keyId !== undefined && algorithm !== undefined) {
      const valid = verifyArtifact(
        signature as string,
        keyId as string,
        algorithm as string,
        this.publicKeys,
        artifact as CompiledPolicyArtifact,
        hash,
      );
      if (!valid) {
        throw new Error(`policy artifact signature verification failed (keyId=${keyId as string})`);
      }
    } else if (this.requireSignature) {
      throw new Error("policy artifact is unsigned and signatures are required");
    }

    return Object.freeze({
      version,
      hash,
      artifact,
      ...(signature === undefined ? {} : { signature: signature as string }),
      ...(keyId === undefined ? {} : { keyId: keyId as string }),
      ...(algorithm === undefined ? {} : { algorithm: algorithm as string }),
    });
  }
}
