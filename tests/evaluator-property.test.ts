import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { InMemoryPolicyStore } from "../packages/policy/src/index.js";
import {
  DecisionCache,
  Evaluator,
  InMemoryRelationshipStore,
  PolicyCache,
} from "../packages/evaluator/src/index.js";
import { ACME_POLICY, publishAndActivate } from "./helpers.js";

/**
 * Generative evaluator properties (Phase 7, `docs/development/testing.md`
 * section 7).
 *
 * The policy is deliberately **fixed** to `ACME_POLICY`: generated policies
 * would test the generator, not the engine. What varies is the graph and the
 * request stream. Three layers of claims:
 *
 * 1. Direct invariants (`testing.md` section 7's named examples) — removal is
 *    monotone, and edges from a disjoint identifier namespace cannot affect
 *    decisions at all.
 * 2. Reference-model parity — a naive permission closure, written as an
 *    independent encoding of the Acme policy, must agree with the engine's
 *    traversal on every generated graph (catches depth, cycle, and
 *    inheritance handling the concrete cases might miss).
 * 3. Cache parity — op sequences replayed against a fully-cached evaluator
 *    and a fresh uncached one must agree on every check, generatively
 *    subsuming the grant/revocation immediacy the concrete security suites
 *    pin case by case.
 */

interface Edge {
  subject: string;
  relation: string;
  resource: string;
}

interface Request {
  subject: string;
  action: string;
  resource: string;
}

const USERS = ["user-a", "user-b", "user-c"] as const;
const ORGS = ["org-a", "org-b"] as const;
const PROJECTS = ["project-a", "project-b", "project-c"] as const;
const DOCS = ["document-a", "document-b"] as const;

/** Prefix helpers so subject/resource strings stay identifier-valid. */
const u = (id: string): string => `user:${id}`;
const o = (id: string): string => `organization:${id}`;
const p = (id: string): string => `project:${id}`;
const d = (id: string): string => `document:${id}`;

/** Schema-valid Acme edges only: subjects/resources/relations must typecheck. */
const edgeArb: fc.Arbitrary<Edge> = fc.oneof(
  fc.record({
    subject: fc.constantFrom(...USERS.map(u)),
    relation: fc.constantFrom("member", "admin"),
    resource: fc.constantFrom(...ORGS.map(o)),
  }),
  fc.record({
    subject: fc.constantFrom(...ORGS.map(o)),
    relation: fc.constant("owns"),
    resource: fc.constantFrom(...PROJECTS.map(p)),
  }),
  fc.record({
    subject: fc.constantFrom(...USERS.map(u)),
    relation: fc.constantFrom("owner", "editor", "viewer"),
    resource: fc.constantFrom(...PROJECTS.map(p)),
  }),
  fc.record({
    subject: fc.constantFrom(...PROJECTS.map(p)),
    relation: fc.constant("contains"),
    resource: fc.constantFrom(...DOCS.map(d)),
  }),
);

/** Requests whose resource type always matches the action prefix. */
const requestArb: fc.Arbitrary<Request> = fc.oneof(
  fc.record({
    subject: fc.constantFrom(...USERS.map(u)),
    action: fc.constantFrom("organization.read", "organization.manage"),
    resource: fc.constantFrom(...ORGS.map(o)),
  }),
  fc.record({
    subject: fc.constantFrom(...USERS.map(u)),
    action: fc.constantFrom("project.read", "project.write", "project.delete"),
    resource: fc.constantFrom(...PROJECTS.map(p)),
  }),
  fc.record({
    subject: fc.constantFrom(...USERS.map(u)),
    action: fc.constantFrom("document.read", "document.delete"),
    resource: fc.constantFrom(...DOCS.map(d)),
  }),
);

/**
 * Edges from a disjoint identifier namespace: valid `type:id` shapes the
 * store accepts, but every ID is foreign to the generators and requests
 * above, so no check can ever reach them. Adding or removing them must be a
 * no-op for every decision.
 */
const disjointEdgeArb: fc.Arbitrary<Edge> = fc.oneof(
  fc.record({
    subject: fc.constant("user:outsider"),
    relation: fc.constantFrom("member", "admin"),
    resource: fc.constant("organization:faraway"),
  }),
  fc.record({
    subject: fc.constant("organization:faraway"),
    relation: fc.constant("owns"),
    resource: fc.constant("project:faraway"),
  }),
  fc.record({
    subject: fc.constant("user:outsider"),
    relation: fc.constantFrom("owner", "editor", "viewer"),
    resource: fc.constant("project:faraway"),
  }),
  fc.record({
    subject: fc.constant("project:faraway"),
    relation: fc.constant("contains"),
    resource: fc.constant("document:faraway"),
  }),
);

const keyOf = (edge: Edge): string => `${edge.subject}|${edge.relation}|${edge.resource}`;

/** An engine over the given edges, sharing the canonical Acme policy. */
async function engineFrom(edges: readonly Edge[]) {
  const policyStore = new InMemoryPolicyStore();
  const relationships = new InMemoryRelationshipStore();
  for (const edge of edges) relationships.add(edge);
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: relationships.asRelationshipStore(),
  });
  await publishAndActivate(policyStore, { source: ACME_POLICY });
  return { evaluator, relationships };
}

/**
 * Naive permission closure: an independent encoding of `ACME_POLICY`
 * (tests/helpers.ts lines 20-40) that answers by direct edge-set inspection
 * rather than traversal. The generated graphs are DAGs by construction —
 * every edge points from a lower level (user) to a higher level (document) —
 * so this total function needs no cycle handling of its own.
 */
function referenceAllows(edges: readonly Edge[], request: Request): boolean {
  const has = (subject: string, relation: string, resource: string): boolean =>
    edges.some((e) => e.subject === subject && e.relation === relation && e.resource === resource);
  // organization: read = admin | member; manage = admin.
  const orgRead = (user: string, org: string): boolean =>
    has(user, "member", org) || has(user, "admin", org);
  const orgManage = (user: string, org: string): boolean => has(user, "admin", org);
  // project: read = viewer | editor | owner | owning-org.read;
  // write = editor | owner; delete = owner | owning-org.manage.
  const projectRead = (user: string, project: string): boolean =>
    has(user, "viewer", project) ||
    has(user, "editor", project) ||
    has(user, "owner", project) ||
    ORGS.map(o).some((org) => has(org, "owns", project) && orgRead(user, org));
  const projectWrite = (user: string, project: string): boolean =>
    has(user, "editor", project) || has(user, "owner", project);
  const projectDelete = (user: string, project: string): boolean =>
    has(user, "owner", project) ||
    ORGS.map(o).some((org) => has(org, "owns", project) && orgManage(user, org));
  // document: read = containing-project.read; delete = containing-project.delete.
  const { subject, action, resource } = request;
  switch (action) {
    case "organization.read":
      return orgRead(subject, resource);
    case "organization.manage":
      return orgManage(subject, resource);
    case "project.read":
      return projectRead(subject, resource);
    case "project.write":
      return projectWrite(subject, resource);
    case "project.delete":
      return projectDelete(subject, resource);
    case "document.read":
      return PROJECTS.map(p).some(
        (project) => has(project, "contains", resource) && projectRead(subject, project),
      );
    case "document.delete":
      return PROJECTS.map(p).some(
        (project) => has(project, "contains", resource) && projectDelete(subject, project),
      );
    default:
      throw new Error(`reference model: unknown action ${action}`);
  }
}

/** Duplicate edges collapse: store sets and `fc.array` both tolerate repeats. */
function dedupe(edges: readonly Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const edge of edges) {
    const key = keyOf(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

type Op =
  | { kind: "check"; request: Request }
  | { kind: "add"; edge: Edge }
  | { kind: "remove"; edge: Edge };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  requestArb.map((request): Op => ({ kind: "check", request })),
  edgeArb.map((edge): Op => ({ kind: "add", edge })),
  edgeArb.map((edge): Op => ({ kind: "remove", edge })),
);

describe("evaluator generative properties", () => {
  // Modest run count: each run builds fresh stores, and the cache-parity
  // property replays a whole op sequence per run. fast-check prints the seed
  // on failure for reproduction.
  const runs = 100;

  it("removing a relationship never turns a DENY into an ALLOW", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(edgeArb, { minLength: 1, maxLength: 12 }),
        fc.nat(11),
        requestArb,
        async (edges, pick, request) => {
          const graph = dedupe(edges);
          const victim = graph[pick % graph.length];
          if (victim === undefined) return;
          const { evaluator, relationships } = await engineFrom(graph);
          const before = (await evaluator.check(request)).allowed;
          relationships.remove(victim);
          const after = (await evaluator.check(request)).allowed;
          // Removal is monotone: an ALLOW may become DENY, never the reverse.
          expect(after && !before).toBe(false);
        },
      ),
      { numRuns: runs },
    );
  });

  it("edges from a disjoint identifier namespace cannot change a decision", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(edgeArb, { maxLength: 10 }),
        fc.array(disjointEdgeArb, { maxLength: 3 }),
        requestArb,
        async (edges, foreign, request) => {
          const graph = dedupe(edges);
          const base = await engineFrom(graph);
          const noisy = await engineFrom([...graph, ...dedupe(foreign)]);
          const expected = (await base.evaluator.check(request)).allowed;
          expect((await noisy.evaluator.check(request)).allowed).toBe(expected);
          // Removing the foreign edges again must not change anything either.
          for (const edge of foreign) noisy.relationships.remove(edge);
          expect((await noisy.evaluator.check(request)).allowed).toBe(expected);
        },
      ),
      { numRuns: runs },
    );
  });

  it("agrees with the naive reference closure on every generated graph", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(edgeArb, { maxLength: 12 }), requestArb, async (edges, request) => {
        const graph = dedupe(edges);
        const { evaluator } = await engineFrom(graph);
        const actual = (await evaluator.check(request)).allowed;
        expect(actual).toBe(referenceAllows(graph, request));
      }),
      { numRuns: runs },
    );
  });

  it("a fully-cached evaluator agrees with a fresh one across op sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(edgeArb, { minLength: 1, maxLength: 6 }),
        fc.array(opArb, { minLength: 4, maxLength: 16 }),
        async (seed, ops) => {
          const policyStore = new InMemoryPolicyStore();
          await publishAndActivate(policyStore, { source: ACME_POLICY });
          const relationships = new InMemoryRelationshipStore();
          relationships.addAll(dedupe(seed));
          const fresh = new Evaluator({
            policyStore,
            relationshipStore: relationships.asRelationshipStore(),
          });
          const warmed = new Evaluator({
            policyStore,
            relationshipStore: relationships.asRelationshipStore(),
            decisionCache: new DecisionCache(),
            policyCache: new PolicyCache(),
            relationshipCache: {},
          });
          for (const op of ops) {
            if (op.kind === "add") relationships.add(op.edge);
            else if (op.kind === "remove") relationships.remove(op.edge);
            else {
              const plain = (await fresh.check(op.request)).allowed;
              const cached = (await warmed.check(op.request)).allowed;
              expect(cached).toBe(plain);
            }
          }
        },
      ),
      { numRuns: runs },
    );
  });
});
