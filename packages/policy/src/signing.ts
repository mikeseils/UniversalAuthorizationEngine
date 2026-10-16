import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson, type CompiledPolicyArtifact } from "./compile.js";

/**
 * Signing algorithm used for policy artifacts. Ed25519: small keys, small
 * signatures, fast verification, no external dependencies
 * (docs/adr/0024-policy-artifact-signing.md).
 */
export type SigningAlgorithm = "ed25519";

export const DEFAULT_SIGNING_ALGORITHM: SigningAlgorithm = "ed25519";

/**
 * Metadata recorded on a signed `VersionedPolicy` (control plane) and checked
 * by the data-plane loader before an artifact is served for evaluation.
 */
export interface SignedArtifactMetadata {
  readonly signature: string; // base64url (no padding) Ed25519 signature
  readonly keyId: string; // kid — identifies the public key used to verify
  readonly algorithm: SigningAlgorithm;
}

/**
 * Sign a compiled policy artifact. The signature covers `canonicalJson({ artifact,
 * hash })` so both the policy body and its content hash are bound together.
 */
export function signArtifact(
  artifact: CompiledPolicyArtifact,
  hash: string,
  privateKeyPem: string,
  options: { keyId?: string } = {},
): SignedArtifactMetadata {
  const privateKey: KeyObject = createPrivateKey(privateKeyPem);
  const data = Buffer.from(canonicalJson({ artifact, hash }), "utf8");
  const signature = sign(null, data, privateKey);
  return {
    signature: signature.toString("base64url"),
    keyId: options.keyId ?? "default",
    algorithm: DEFAULT_SIGNING_ALGORITHM,
  };
}

/**
 * Verify a signed artifact's signature against a map of `keyId → PEM public
 * key`. Returns `true` when the signature is valid for the given artifact and
 * hash under the identified key, `false` otherwise (unknown key, bad
 * signature, malformed input).
 */
export function verifyArtifact(
  signature: string,
  keyId: string,
  algorithm: string,
  publicKeys: Record<string, string>,
  artifact: CompiledPolicyArtifact,
  hash: string,
): boolean {
  if (algorithm !== DEFAULT_SIGNING_ALGORITHM) return false;
  const publicKeyPem = publicKeys[keyId];
  if (publicKeyPem === undefined) return false;
  try {
    const publicKey: KeyObject = createPublicKey(publicKeyPem);
    const data = Buffer.from(canonicalJson({ artifact, hash }), "utf8");
    const sigBuffer = Buffer.from(signature, "base64url");
    return verify(null, data, publicKey, sigBuffer);
  } catch {
    return false;
  }
}

/**
 * Generate an Ed25519 key pair for development or bootstrapping. Returns PEM
 * strings (PKCS#8 private key, SPKI public key).
 */
export function generateSigningKeyPair(): {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
    publicKeyPem: publicKey.export({
      type: "spki",
      format: "pem",
    }) as string,
  };
}
