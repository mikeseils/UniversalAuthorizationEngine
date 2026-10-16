# ADR-0024: Policy artifact signing

- Status: Accepted
- Date: 2026-10-15

## Context

Phase 7 introduced version-keyed, immutable policy artifacts (ADR-0022). Phase 8
introduces the data plane: an independently deployable node that consumes
compiled policy artifacts and answers authorization checks without constant
control-plane access (ADR-0007). The data plane must not blindly trust the
control plane at runtime — a compromised dashboard or publishing pipeline must
not be able to silently escalate production access by pushing a malicious
artifact.

## Decision

Policy artifacts are **cryptographically signed at publish time** and **verified
at load time** before the data plane evaluates against them.

1. **Algorithm: Ed25519.** Small keys, small signatures, fast verification, no
   hash-algorithm agility needed (Node's `crypto.sign`/`verify` with `null`
   algorithm for Ed25519). Suitable for both control-plane signing and
   data-plane verification with zero external dependencies.

2. **Key format: PEM.** Private keys are PKCS#8 `-----BEGIN PRIVATE KEY-----`;
   public keys are SPKI `-----BEGIN PUBLIC KEY-----`. Keys are identified by a
   `keyId` (`kid`) to support rotation: the data plane verifies against a map
   of `keyId → PEM`, so rotating keys requires no coordinated deployment.

3. **Signed artifact structure.** The signature covers the canonical JSON of
   `{ artifact, hash }` so that both the policy body and its content hash are
   bound together. The signed artifact carries `signature` (base64url),
   `keyId`, and `algorithm`.

4. **Where signing happens.** `InMemoryPolicyStore.publishPolicy` accepts an
   optional `signingKey` (PEM) plus optional `keyId`; when provided, the
   published `VersionedPolicy` carries `signature`, `keyId`, and `algorithm`.
   When absent, publishing is unchanged — unsigned artifacts remain loadable
   locally for development. The data plane's loader verifies the signature
   against configured public keys before exposing the artifact to evaluation;
   an unverifiable artifact fails to load (fail-closed).

5. **Where verification happens.** Any code path that loads a `VersionedPolicy`
   for evaluation — the evaluator's `loadVersion`, the data-plane artifact
   loader — checks `verifyArtifact` when `signature` is present and public keys
   are configured. A missing signature with configured keys is a load error,
   not a silent skip.

## Consequences

- **Positive:** A compromised control plane cannot push an unsigned or
  wrongly-signed artifact to a verifying data plane. Key rotation is supported
  via `kid` without re-signing history.
- **Negative:** Adds key management (generation, storage, rotation) to the
  operational surface. Development remains unsigned by default; signature
  verification is opt-in per deployment via configured public keys.
- **Unsigned artifacts:** `publishPolicy` without a signing key produces a
  `VersionedPolicy` with no `signature`/`keyId`/`algorithm`. Loaders that have
  no configured public keys treat unsigned artifacts as before; loaders with
  configured keys reject unsigned artifacts.

## Alternatives considered

- **RSA-PSS / ECDSA:** Larger keys and signatures, more algorithm agility to
  maintain. Ed25519 is strictly better for this use case.
- **Signing only the hash:** A hash collision or hash-substitution attack
  would decouple signature from body. Signing `canonicalJson({ artifact, hash })`
  binds both.
- **JWT / JWS:** Heavier than needed; no JWT ecosystem in the dependency-free
  codebase. Raw Ed25519 over canonical JSON is simpler to audit.

## Related

- ADR-0007: Control plane / data plane trust boundary (signed artifacts).
- ADR-0022: Version-keyed policy artifact cache (immutable, content-addressed).
- ADR-0013: Wire formats versioned independently from code APIs.