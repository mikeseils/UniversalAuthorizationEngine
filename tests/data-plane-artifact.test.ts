import { describe, expect, it } from "vitest";
import { ArtifactLoader } from "../packages/data-plane/src/artifact-loader.js";
import { generateSigningKeyPair, signArtifact } from "../packages/policy/src/signing.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compileStructuredPolicy, type StructuredPolicy } from "../packages/policy/src/index.js";
import { anyOf, relationRef } from "../packages/policy/src/index.js";

const POLICY: StructuredPolicy = {
  definitions: {
    document: {
      relations: { owner: { subjectTypes: ["user"] } },
      permissions: { read: anyOf(relationRef("owner")) },
    },
  },
};

function writeArtifactFile(dir: string, content: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("ArtifactLoader", () => {
  it("loads an unsigned artifact", async () => {
    const dir = join(process.cwd(), "tests", "tmp-artifact-unsigned");
    const { artifact, hash } = compileStructuredPolicy(POLICY);
    const path = writeArtifactFile(dir, { version: "1", hash, artifact });

    const loader = new ArtifactLoader({ artifactPath: path, publicKeys: {} });
    await loader.load();

    const versioned = loader.policyStore.getActiveVersion();
    expect(versioned).toBe("1");

    const policy = await loader.policyStore.getPolicyVersion("1");
    expect(policy?.signature).toBeUndefined();
    expect(policy?.keyId).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it("loads and verifies a signed artifact", async () => {
    const dir = join(process.cwd(), "tests", "tmp-artifact-signed");
    const { artifact, hash } = compileStructuredPolicy(POLICY);
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const signed = signArtifact(artifact, hash, privateKeyPem, { keyId: "key-1" });
    const path = writeArtifactFile(dir, {
      version: "1",
      hash,
      artifact,
      signature: signed.signature,
      keyId: signed.keyId,
      algorithm: signed.algorithm,
    });

    const loader = new ArtifactLoader({
      artifactPath: path,
      publicKeys: { "key-1": publicKeyPem },
    });
    await loader.load();

    const policy = await loader.policyStore.getPolicyVersion("1");
    expect(policy?.signature).toBe(signed.signature);
    expect(policy?.keyId).toBe("key-1");
    expect(policy?.algorithm).toBe("ed25519");

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a tampered signed artifact", async () => {
    const dir = join(process.cwd(), "tests", "tmp-artifact-tampered");
    const { artifact, hash } = compileStructuredPolicy(POLICY);
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const signed = signArtifact(artifact, hash, privateKeyPem, { keyId: "key-1" });
    // Tamper: add a bogus relation to the artifact body.
    const tampered = {
      ...artifact,
      definitions: {
        ...artifact.definitions,
        evil: { relations: {}, permissions: { read: anyOf(relationRef("owner")) } },
      },
    };
    const path = writeArtifactFile(dir, {
      version: "1",
      hash,
      artifact: tampered,
      signature: signed.signature,
      keyId: signed.keyId,
      algorithm: signed.algorithm,
    });

    const loader = new ArtifactLoader({
      artifactPath: path,
      publicKeys: { "key-1": publicKeyPem },
    });
    await expect(loader.load()).rejects.toThrow(/signature verification failed/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unsigned artifact when signatures are required", async () => {
    const dir = join(process.cwd(), "tests", "tmp-artifact-required");
    const { artifact, hash } = compileStructuredPolicy(POLICY);
    const path = writeArtifactFile(dir, { version: "1", hash, artifact });

    const loader = new ArtifactLoader({
      artifactPath: path,
      publicKeys: {},
      requireSignature: true,
    });
    await expect(loader.load()).rejects.toThrow(/unsigned/);

    rmSync(dir, { recursive: true, force: true });
  });
});
