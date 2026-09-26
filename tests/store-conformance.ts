import { describe, expect, it } from "vitest";
import {
  PolicySource,
  Relationship,
  RelationshipStore,
  ValidationError,
  VersionedPolicy,
  parseIdentifier,
} from "../packages/core/src/index.js";
import { InMemoryPolicyStore } from "../packages/policy/src/index.js";
import { InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import { ACME_POLICY } from "./helpers.js";

/**
 * Store conformance suite (ADR-0018).
 *
 * The contract in ADR-0018 is normative, but prose contracts rot - so it is
 * expressed as an executable spec. {@link describeStoreContract} runs against
 * **every** store implementation; the in-memory store is the reference and is
 * not exempt. A new backend is not "done" until it passes unmodified.
 *
 * Backends are adapted through {@link StoreFixture}, which adds the write
 * surface (`RelationshipWriter`) that the core read interface omits by design.
 */

const SUBJECT = parseIdentifier("user:alice");
const OTHER_SUBJECT = parseIdentifier("user:bob");
const PROJECT = parseIdentifier("project:alpha");
const DOC_A = parseIdentifier("document:a");
const DOC_B = parseIdentifier("document:b");

/** Seed graph: an admin, a viewer, and a project containing two documents. */
export const EDGES: readonly Relationship[] = [
  { subject: SUBJECT, relation: "admin", resource: PROJECT },
  { subject: OTHER_SUBJECT, relation: "viewer", resource: PROJECT },
  { subject: PROJECT, relation: "contains", resource: DOC_A },
  { subject: PROJECT, relation: "contains", resource: DOC_B },
];

/** Write surface every backend must provide (idempotent - ADR-0018 S5). */
export interface RelationshipWriter {
  add(input: unknown): Promise<Relationship>;
  remove(input: unknown): Promise<boolean>;
}

/** Activation capability policy stores expose beyond the core interface. */
export interface ActivatablePolicyStore {
  publishPolicy(policy: PolicySource): Promise<VersionedPolicy>;
  getActivePolicy(): Promise<VersionedPolicy>;
  getPolicyVersion(version: string): Promise<VersionedPolicy | null>;
  setActiveVersion(version: string): void;
  getActiveVersion(): string | null;
}

export interface StoreFixture {
  readonly name: string;
  create(): Promise<{
    readonly store: RelationshipStore;
    readonly writer: RelationshipWriter;
    readonly policies: ActivatablePolicyStore;
  }>;
  /** Optional cleanup (e.g. truncate tables) before each test. */
  reset?(): Promise<void>;
}

/** Normalize a caught value to an `Error` for Promise rejection. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The in-memory reference backend, exposed as a fixture. */
export function inMemoryFixture(name = "InMemoryRelationshipStore"): StoreFixture {
  return {
    name,
    // The in-memory store is synchronous. These wrappers are deliberately
    // `Promise.reject` on throw (not `Promise.resolve(store.add(...))`, which
    // would evaluate eagerly and throw synchronously, escaping the Promise
    // contract every async backend follows).
    create: () => {
      const store = new InMemoryRelationshipStore();
      return Promise.resolve({
        store: store.asRelationshipStore(),
        writer: {
          add: (input: unknown) => {
            try {
              return Promise.resolve(store.add(input));
            } catch (error) {
              return Promise.reject(toError(error));
            }
          },
          remove: (input: unknown) => {
            try {
              return Promise.resolve(store.remove(input));
            } catch (error) {
              return Promise.reject(toError(error));
            }
          },
        },
        policies: new InMemoryPolicyStore(),
      });
    },
  };
}

/**
 * The relationship-store contract (ADR-0018 S1-S6). Every implementation runs
 * this unmodified - the in-memory reference included, so it cannot drift into
 * being a second, laxer specification.
 */
export function describeStoreContract(fixture: StoreFixture): void {
  describe(`store conformance: ${fixture.name}`, () => {
    async function fresh() {
      await fixture.reset?.();
      return fixture.create();
    }

    async function seeded() {
      const ctx = await fresh();
      for (const edge of EDGES) await ctx.writer.add(edge);
      return ctx;
    }

    // S1 - an unbound field matches "all"
    it("S1: an unbound query field matches every value for that position", async () => {
      const { store } = await seeded();
      const bySubject = await store.getRelationships({ subject: SUBJECT });
      expect(bySubject).toHaveLength(1);
      expect(bySubject[0]?.relation).toBe("admin");

      const byResource = await store.getRelationships({ resource: PROJECT });
      expect(byResource).toHaveLength(2);

      const byRelation = await store.getRelationships({ relation: "contains" });
      expect(byRelation).toHaveLength(2);

      expect(await store.getRelationships({})).toHaveLength(EDGES.length);
    });

    it("S1: positions do not leak into each other", async () => {
      const { store } = await seeded();
      // SUBJECT is a user, not a project: binding it as `resource` must not match.
      expect(await store.getRelationships({ resource: SUBJECT })).toEqual([]);
      expect(await store.getRelationships({ subject: parseIdentifier("user:nobody") })).toEqual([]);
    });

    it("S1: bound fields filter conjunctively", async () => {
      const { store } = await seeded();
      expect(await store.getRelationships({ subject: PROJECT, relation: "contains" })).toHaveLength(
        2,
      );
      expect(await store.getRelationships({ subject: PROJECT, relation: "admin" })).toEqual([]);
      expect(await store.getRelationships({ subject: SUBJECT, relation: "viewer" })).toEqual([]);
    });

    // S3 - deterministic ordering (explanations embed row order)
    it("S3: identical contents and query yield identical row order", async () => {
      const { store } = await seeded();
      const first = await store.getRelationships({ resource: PROJECT });
      for (let i = 0; i < 3; i += 1) {
        expect(await store.getRelationships({ resource: PROJECT })).toEqual(first);
      }
    });

    it("S3: ordering is stable across repeated queries of the full set", async () => {
      const { store } = await seeded();
      const all = await store.getRelationships({});
      for (let i = 0; i < 3; i += 1) {
        expect(await store.getRelationships({})).toEqual(all);
      }
    });

    // S5 - idempotent, retry-safe writes (networks fail)
    it("S5: adding an existing relationship twice is a no-op", async () => {
      const { store, writer } = await seeded();
      const edge = EDGES[0] as Relationship;
      await writer.add(edge);
      await writer.add(edge);
      expect(await store.getRelationships({ subject: SUBJECT })).toHaveLength(1);
    });

    it("S5: removing a non-existent relationship succeeds", async () => {
      const { writer } = await seeded();
      const removed = await writer.remove({
        subject: "user:ghost",
        relation: "admin",
        resource: "project:ghost",
      });
      expect(removed).toBe(false);
    });

    it("S5: repeated removal is safe to retry", async () => {
      const { store, writer } = await seeded();
      const edge = EDGES[0] as Relationship;
      expect(await writer.remove(edge)).toBe(true);
      expect(await writer.remove(edge)).toBe(false);
      expect(await store.getRelationships({ subject: SUBJECT })).toEqual([]);
    });

    it("S5: remove then add restores exactly one row", async () => {
      const { store, writer } = await seeded();
      const edge = EDGES[0] as Relationship;
      await writer.remove(edge);
      await writer.add(edge);
      await writer.add(edge);
      expect(await store.getRelationships({ subject: SUBJECT })).toHaveLength(1);
    });

    // S6 - rows are frozen, not aliased internal state
    it("S6: returned relationships are frozen", async () => {
      const { store } = await seeded();
      const row = (await store.getRelationships({ subject: SUBJECT }))[0];
      expect(row).toBeDefined();
      expect(Object.isFrozen(row)).toBe(true);
    });

    // Boundary validation - malformed input never becomes stored state
    it("rejects a malformed relationship at the write boundary", async () => {
      const { writer } = await fresh();
      await expect(writer.add({ subject: "nope", relation: "x", resource: "y" })).rejects.toThrow(
        ValidationError,
      );
    });

    it("rejects a malformed relation name at the write boundary", async () => {
      const { writer } = await fresh();
      await expect(
        writer.add({ subject: "user:a", relation: "Bad Relation", resource: "project:p" }),
      ).rejects.toThrow(ValidationError);
    });

    // S2 - a later mutation is observed by later reads (per-check snapshot
    // binding is the backend's job; see the persistence suite)
    it("S2: mutations are visible to subsequent reads", async () => {
      const { store, writer } = await seeded();
      const contains = { subject: PROJECT, relation: "contains" };
      expect(await store.getRelationships(contains)).toHaveLength(2);
      await writer.add({
        subject: PROJECT,
        relation: "contains",
        resource: parseIdentifier("document:c"),
      });
      expect(await store.getRelationships(contains)).toHaveLength(3);
    });

    it("S2: a removal is not observed by an in-flight read", async () => {
      const { store, writer } = await seeded();
      const hop1 = await store.getRelationships({ subject: PROJECT, relation: "contains" });
      await writer.remove(EDGES[2]);
      const hop2 = await store.getRelationships({ subject: PROJECT, relation: "contains" });
      expect(hop1).toHaveLength(2);
      expect(hop2).toHaveLength(1);
    });
  });
}

/**
 * The policy-store contract (ADR-0018 S7-S10).
 *
 * S7 is the security-relevant one: publishing must never activate. Activation
 * is a deliberate deployment act, so a publish can never surprise a running
 * data plane with new policy.
 */
export function describePolicyStoreContract(
  name: string,
  create: () => Promise<ActivatablePolicyStore>,
  source: PolicySource = { source: ACME_POLICY },
): void {
  describe(`policy store conformance: ${name}`, () => {
    it("S7: publishing does not activate", async () => {
      const store = await create();
      const published = await store.publishPolicy(source);
      expect(store.getActiveVersion()).toBeNull();
      await expect(store.getActivePolicy()).rejects.toThrow();
      store.setActiveVersion(published.version);
      expect(store.getActiveVersion()).toBe(published.version);
    });

    it("S7: activation of an unknown version is rejected", async () => {
      const store = await create();
      expect(() => {
        store.setActiveVersion("999");
      }).toThrow();
    });

    it("S8: artifacts are content-addressed and versions are distinct", async () => {
      const store = await create();
      const a = await store.publishPolicy(source);
      const b = await store.publishPolicy(source);
      expect(a.hash).toBe(b.hash);
      expect(a.version).not.toBe(b.version);
    });

    it("S8: a stored version is frozen and retrievable by version", async () => {
      const store = await create();
      const published = await store.publishPolicy(source);
      const fetched = await store.getPolicyVersion(published.version);
      expect(fetched?.hash).toBe(published.hash);
      expect(fetched?.artifact).toEqual(published.artifact);
      expect(Object.isFrozen(fetched)).toBe(true);
    });

    it("S9: unknown versions return null", async () => {
      const store = await create();
      expect(await store.getPolicyVersion("does-not-exist")).toBeNull();
    });

    it("S9: a missing active pointer is an error, not a null policy", async () => {
      const store = await create();
      await expect(store.getActivePolicy()).rejects.toThrow();
    });

    it("S9: activating then reading returns exactly that version", async () => {
      const store = await create();
      const first = await store.publishPolicy(source);
      // A second, genuinely different but valid policy.
      const second = await store.publishPolicy({
        source: {
          definitions: {
            organization: { relations: {}, permissions: {} },
          },
        },
      });
      store.setActiveVersion(first.version);
      expect((await store.getActivePolicy()).version).toBe(first.version);
      store.setActiveVersion(second.version);
      expect((await store.getActivePolicy()).version).toBe(second.version);
    });

    it("S10: malformed policy source is rejected and stores no version", async () => {
      const store = await create();
      await expect(store.publishPolicy({ source: "{ not a policy" })).rejects.toThrow();
      expect(await store.getPolicyVersion("1")).toBeNull();
    });
  });
}
