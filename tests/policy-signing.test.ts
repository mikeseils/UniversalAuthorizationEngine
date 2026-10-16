import { describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
  signArtifact,
  verifyArtifact,
} from "../packages/policy/src/signing.js";
import {
  compileStructuredPolicy,
  type CompiledPolicyArtifact,
} from "../packages/policy/src/compile.js";
import { anyOf, relationRef, type StructuredPolicy } from "../packages/policy/src/index.js";
import { InMemoryPolicyStore } from "../packages/policy/src/store.js";

const POLICY: StructuredPolicy = {
  definitions: {
    document: {
      relations: { owner: { subjectTypes: ["user"] } },
      permissions: { read: anyOf(relationRef("owner")) },
    },
  },
};

function compile(policy: StructuredPolicy): { artifact: CompiledPolicyArtifact; hash: string } {
  return compileStructuredPolicy(policy);
}

describe("policy artifact signing (ADR-0024)", () => {
  describe("signArtifact / verifyArtifact round trip", () => {
    it("signs and verifies a compiled artifact", () => {
      const { artifact, hash } = compile(POLICY);
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      const signed = signArtifact(artifact, hash, privateKeyPem, { keyId: "key-1" });

      expect(signed.algorithm).toBe("ed25519");
      expect(signed.keyId).toBe("key-1");
      expect(typeof signed.signature).toBe("string");
      expect(signed.signature.length).toBeGreaterThan(0);

      expect(
        verifyArtifact(
          signed.signature,
          signed.keyId,
          signed.algorithm,
          { "key-1": publicKeyPem },
          artifact,
          hash,
        ),
      ).toBe(true);
    });

    it("defaults keyId to 'default'", () => {
      const { artifact, hash } = compile(POLICY);
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      const signed = signArtifact(artifact, hash, privateKeyPem);

      expect(signed.keyId).toBe("default");
      expect(
        verifyArtifact(
          signed.signature,
          "default",
          signed.algorithm,
          { default: publicKeyPem },
          artifact,
          hash,
        ),
      ).toBe(true);
    });
  });
  describe("verification rejects invalid signatures", () => {
    it("rejects a tampered artifact", () => {
      const { artifact, hash } = compile(POLICY);
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      const signed = signArtifact(artifact, hash, privateKeyPem);

      const tampered: CompiledPolicyArtifact = {
        definitions: {
          ...artifact.definitions,
          evil: {
            relations: {},
            permissions: { read: anyOf(relationRef("owner")) },
          },
        },
      };

      expect(
        verifyArtifact(
          signed.signature,
          signed.keyId,
          signed.algorithm,
          { "key-1": publicKeyPem },
          tampered,
          hash,
        ),
      ).toBe(false);
    });

    it("rejects a wrong public key", () => {
      const { artifact, hash } = compile(POLICY);
      const { privateKeyPem } = generateSigningKeyPair();
      const { publicKeyPem: wrongPublicKey } = generateSigningKeyPair();
      const signed = signArtifact(artifact, hash, privateKeyPem, { keyId: "key-1" });

      expect(
        verifyArtifact(
          signed.signature,
          "key-1",
          signed.algorithm,
          { "key-1": wrongPublicKey },
          artifact,
          hash,
        ),
      ).toBe(false);
    });

    it("rejects an unknown keyId", () => {
      const { artifact, hash } = compile(POLICY);
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      const signed = signArtifact(artifact, hash, privateKeyPem, { keyId: "key-1" });

      expect(
        verifyArtifact(
          signed.signature,
          "key-1",
          signed.algorithm,
          { "other-key": publicKeyPem },
          artifact,
          hash,
        ),
      ).toBe(false);
    });

    it("rejects a tampered signature", () => {
      const { artifact, hash } = compile(POLICY);
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      const signed = signArtifact(artifact, hash, privateKeyPem);

      expect(
        verifyArtifact(
          signed.signature + "aaaa",
          signed.keyId,
          signed.algorithm,
          { "key-1": publicKeyPem },
          artifact,
          hash,
        ),
      ).toBe(false);
    });

    it("rejects a wrong algorithm", () => {
      const { artifact, hash } = compile(POLICY);
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      const signed = signArtifact(artifact, hash, privateKeyPem);

      expect(
        verifyArtifact(
          signed.signature,
          signed.keyId,
          "rsa-pss",
          { "key-1": publicKeyPem },
          artifact,
          hash,
        ),
      ).toBe(false);
    });
  });

  describe("InMemoryPolicyStore.publishPolicy with signing", () => {
    it("publishes an unsigned artifact when no signing key is given", async () => {
      const store = new InMemoryPolicyStore();
      const versioned = await store.publishPolicy({ source: POLICY });

      expect(versioned.signature).toBeUndefined();
      expect(versioned.keyId).toBeUndefined();
      expect(versioned.algorithm).toBeUndefined();
      expect(versioned.hash).toBeDefined();
    });

    it("publishes a signed artifact when a signing key is given", async () => {
      const store = new InMemoryPolicyStore();
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      const versioned = await store.publishPolicy(
        { source: POLICY },
        { signingKey: privateKeyPem, keyId: "key-1" },
      );

      expect(versioned.signature).toBeDefined();
      expect(versioned.keyId).toBe("key-1");
      expect(versioned.algorithm).toBe("ed25519");

      const signature = versioned.signature;
      const keyId = versioned.keyId;
      const algorithm = versioned.algorithm;
      if (signature === undefined || keyId === undefined || algorithm === undefined) {
        throw new Error("expected signed artifact");
      }
      const { artifact, hash } = versioned;
      expect(
        verifyArtifact(
          signature,
          keyId,
          algorithm,
          { "key-1": publicKeyPem },
          artifact as CompiledPolicyArtifact,
          hash,
        ),
      ).toBe(true);
    });

    it("keeps unsigned and signed artifacts separate across versions", async () => {
      const store = new InMemoryPolicyStore();
      const { privateKeyPem } = generateSigningKeyPair();

      const v1 = await store.publishPolicy({ source: POLICY });
      expect(v1.signature).toBeUndefined();
      expect(v1.version).toBe("1");

      const v2 = await store.publishPolicy({ source: POLICY }, { signingKey: privateKeyPem });
      expect(v2.signature).toBeDefined();
      expect(v2.version).toBe("2");

      const v3 = await store.publishPolicy({ source: POLICY });
      expect(v3.signature).toBeUndefined();
      expect(v3.version).toBe("3");
    });
  });
});
