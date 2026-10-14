import { describe, expect, it } from "vitest";
import {
  ActivatablePolicyStore,
  PolicySource,
  Relationship,
  RelationshipStore,
  ValidationError,
  parseIdentifier,
} from "../packages/core/src/index.js";
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

/**
 * Write surface every backend must provide (idempotent - ADR-0018 S5).
 *
 * The version surface (ADR-0018 S11, Phase 7) is intentionally combined with
 * the writer: a backend that can mutate state must also be able to say *which*
 * state it holds, or version-keyed decision caching cannot be safe against it.
 */
export interface RelationshipWriter {
  add(input: unknown): Promise<Relationship>;
  remove(input: unknown): Promise<boolean>;
  /**
   * Current relationship-state version as an opaque token (ADR-0018 S11).
   *
   * Reads must be side-effect free: observing the version must never advance
   * it. Backends expose their natural clock — the in-memory counter rendered
   * as a string, the Postgres sequence value — and callers treat it as opaque,
   * comparing with `!==`, never parsing or ordering it.
   */
  getVersion(): Promise<string>;
}

/**
 * The policy-store surface the contract drives: the core *control-plane* view
 * (ADR-0018 S7 activation) plus what the contract needs beyond it — the
 * active-version pointer read (S7/S9) and an optional reset for backends that
 * share state across store instances (Postgres rows in one database).
 */
export interface PolicyStoreUnderTest extends ActivatablePolicyStore {
  /** Read the active version pointer (null when nothing is active). */
  getActiveVersion(): string | null | Promise<string | null>;
  /** Optional cleanup between tests (truncate tables, reset counters). */
  reset?(): Promise<void>;
}

export interface StoreFixture {
  readonly name: string;
  create(): Promise<{
    readonly store: RelationshipStore;
    readonly writer: RelationshipWriter;
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
    reset: () => Promise.resolve(),
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
          getVersion: () => store.getRelationshipVersion(),
        },
      });
    },
  };
}

/**
 * The relationship-store contract (ADR-0018 S1-S6, S11). Every implementation
 * runs this unmodified - the in-memory reference included, so it cannot drift
 * into being a second, laxer specification.
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

    // S11 - opaque state version for cache keying (Phase 7)
    it("S11: reading the version is side-effect free", async () => {
      const { writer } = await seeded();
      // Repeated reads must return the same token: a read that advanced the
      // version would invalidate the very cache entry its own token keys
      // (docs/architecture/caching.md rule 1), giving 0% hit rate at best and
      // serving stale decisions at worst.
      const first = await writer.getVersion();
      const second = await writer.getVersion();
      const third = await writer.getVersion();
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(typeof first).toBe("string");
    });

    it("S11: the version changes when — and only when — state changes", async () => {
      const { writer } = await seeded();
      const before = await writer.getVersion();

      // A successful mutation moves the token so cached decisions keyed on
      // the old one can no longer be served.
      await writer.add({
        subject: SUBJECT,
        relation: "admin",
        resource: parseIdentifier("document:z"),
      });
      const afterAdd = await writer.getVersion();
      expect(afterAdd).not.toBe(before);

      // A no-op write (idempotent re-add, S5) must NOT move it: token churn
      // on unchanged state would evict the whole cache on ordinary retry
      // traffic — the exact failure mode persistence-sql.test.ts pins for
      // the Postgres bump.
      await writer.add({
        subject: SUBJECT,
        relation: "admin",
        resource: parseIdentifier("document:z"),
      });
      expect(await writer.getVersion()).toBe(afterAdd);

      const noopRemove = await writer.remove({
        subject: "user:ghost",
        relation: "admin",
        resource: "project:ghost",
      });
      expect(noopRemove).toBe(false);
      expect(await writer.getVersion()).toBe(afterAdd);

      // A real removal moves it again.
      expect(await writer.remove(EDGES[0])).toBe(true);
      expect(await writer.getVersion()).not.toBe(afterAdd);
    });
  });
}

/**
 * Options for {@link describePolicyStoreContract}.
 *
 * `reset` runs before each case when the backend shares state across the
 * store instances `create` returns (e.g. Postgres rows in one database).
 * In-memory stores return a fresh instance per `create`, so they omit it.
 */
export interface PolicyContractOptions {
  readonly source?: PolicySource;
  readonly reset?: () => Promise<void>;
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
  create: () => Promise<PolicyStoreUnderTest>,
  options: PolicyContractOptions = {},
): void {
  const source: PolicySource = options.source ?? { source: ACME_POLICY };
  describe(`policy store conformance: ${name}`, () => {
    async function fresh(): Promise<PolicyStoreUnderTest> {
      // Shared-state backends (Postgres) reset via `options.reset`; fresh
      // instances (in-memory) start clean by construction. Exactly one path
      // runs per backend: calling both would let the second mask the first's
      // failures and doubles the cleanup surface for no isolation gain.
      const store = await create();
      if (options.reset !== undefined) await options.reset();
      else await store.reset?.();
      return store;
    }

    /**
     * Normalize sync-throw (in-memory) and async-reject (Postgres) activation
     * into a promise: `await expect(activate(...)).rejects` works for both,
     * while `await expect(store.setActiveVersion(...)).rejects` would let a
     * sync throw escape argument evaluation and fail the test outright.
     */
    async function activate(store: PolicyStoreUnderTest, version: string): Promise<void> {
      await store.setActiveVersion(version);
    }

    it("S7: publishing does not activate", async () => {
      const store = await fresh();
      const published = await store.publishPolicy(source);
      expect(await store.getActiveVersion()).toBeNull();
      await expect(store.getActivePolicy()).rejects.toThrow();
      await activate(store, published.version);
      expect(await store.getActiveVersion()).toBe(published.version);
    });

    it("S7: activation of an unknown version is rejected", async () => {
      const store = await fresh();
      await expect(activate(store, "999")).rejects.toThrow();
    });

    it("S8: artifacts are content-addressed and versions are distinct", async () => {
      const store = await fresh();
      const a = await store.publishPolicy(source);
      const b = await store.publishPolicy(source);
      expect(a.hash).toBe(b.hash);
      expect(a.version).not.toBe(b.version);
    });

    it("S8: a stored version is frozen and retrievable by version", async () => {
      const store = await fresh();
      const published = await store.publishPolicy(source);
      const fetched = await store.getPolicyVersion(published.version);
      expect(fetched?.hash).toBe(published.hash);
      expect(fetched?.artifact).toEqual(published.artifact);
      expect(Object.isFrozen(fetched)).toBe(true);
    });

    it("S9: unknown versions return null", async () => {
      const store = await fresh();
      expect(await store.getPolicyVersion("does-not-exist")).toBeNull();
    });

    it("S9: a missing active pointer is an error, not a null policy", async () => {
      const store = await fresh();
      await expect(store.getActivePolicy()).rejects.toThrow();
    });

    it("S9: activating then reading returns exactly that version", async () => {
      const store = await fresh();
      const first = await store.publishPolicy(source);
      // A second, genuinely different but valid policy.
      const second = await store.publishPolicy({
        source: {
          definitions: {
            organization: { relations: {}, permissions: {} },
          },
        },
      });
      await activate(store, first.version);
      expect((await store.getActivePolicy()).version).toBe(first.version);
      await activate(store, second.version);
      expect((await store.getActivePolicy()).version).toBe(second.version);
    });

    it("S10: malformed policy source is rejected and stores no version", async () => {
      const store = await fresh();
      // Snapshot the version space first: the check is "no NEW version was
      // stored", not "version 1 is absent" — backends that share version
      // allocation (e.g. a database sequence) may already be past "1".
      const before = await store.publishPolicy(source);
      await expect(store.publishPolicy({ source: "{ not a policy" })).rejects.toThrow();
      const after = await store.publishPolicy(source);
      expect(Number(after.version)).toBe(Number(before.version) + 1);
    });
  });
}
