/**
 * Phase 6 access-pattern benchmark (ADR-0017).
 *
 * Run from the repository root (builds first, since the harness consumes the
 * compiled packages — Node 18 cannot execute TypeScript directly):
 *   pnpm bench
 *
 * The roadmap makes the database choice conditional on *measured* access
 * patterns, so this harness produces evidence rather than intuition. Per
 * workload it reports the query shapes the evaluator actually issues, queries
 * per check (fan-out multiplier), result-set size distribution, and check
 * latency. Dependency-free; runs against the in-memory store by default, and
 * the **same** harness also runs against PostgreSQL when `AUTHZ_TEST_PG_URL`
 * is set, so the two backends are directly comparable.
 *
 *   pnpm bench                                  # in-memory only
 *   AUTHZ_TEST_PG_URL=postgres://… pnpm bench    # in-memory AND Postgres
 *
 * Phase 7 (ADR-0021/0022/0023) adds a cache arm per workload: decision-cache
 * cold and warm passes over the repeating stream, and a relationship-query
 * cache arm over a stream of distinct checks that share sub-traversals.
 *
 * Completing Phase 7 adds three things. First, **stage profiling**: the
 * uncached arm runs with an observer that accumulates elapsedMs per stage, so
 * each workload prints where check time goes (normalize, policy load,
 * decision) without touching the engine — aggregation, not instrumentation.
 * Second, a **batch arm** reporting checkBatch (chunked at maxBatchSize)
 * against N x check on the same stream, with a counting proxy for version
 * reads that measures the Phase 7 one-read-per-batch saving as a number.
 * Third, a **large-policy workload** with a wider clause set and a deeper
 * resource hierarchy, exercising traversal depth and clause fan-out.
 */

import {
  DecisionCache,
  Evaluator,
  InMemoryRelationshipStore,
  InstrumentedRelationshipStore,
  percentiles,
} from "../packages/evaluator/dist/index.js";
import { InMemoryPolicyStore } from "../packages/policy/dist/index.js";

/** When unset, the benchmark measures the in-memory store only. */
const PG_URL_ENV = "AUTHZ_TEST_PG_URL";
const PG_URL = process.env[PG_URL_ENV];

const POLICY = `
definition organization {
  relation member: user
  relation admin: user

  permission read = member or admin
  permission manage = admin
}

definition project {
  // Incoming "owns" edge: organization --owns--> project (ADR-0012).
  relation organization: organization via owns
  relation owner: user
  relation editor: user
  relation viewer: user

  permission read = viewer or editor or owner or organization.read
  permission write = editor or owner
  permission admin = owner or organization.manage
}

definition document {
  // Incoming "contains" edge: project --contains--> document.
  relation project: project via contains

  permission read = project.read
  permission write = project.write
  permission delete = project.admin
}
`;

const POLICY_VIEWER = `  permission read = viewer or editor or owner or organization.read`;

/** The large-policy variant: wider clauses plus a folder level (org -> project -> folder -> document). */
const POLICY_LARGE = POLICY.replace(
  POLICY_VIEWER,
  `  permission read = viewer or editor or owner or organization.read or organization.manage
  permission comment = viewer or editor or owner
  permission share = owner or organization.manage`,
)
  .replace(
    `  // Incoming "contains" edge: project --contains--> document.
  relation project: project via contains

  permission read = project.read
  permission write = project.write
  permission delete = project.admin`,
    `  // Large-policy variant: documents may live in folders (inheriting the
  // folder's permissions) or directly in projects (the baseline rule).
  relation project: project via contains
  relation folder: folder via contains

  permission read = project.read or folder.read
  permission write = project.write or folder.write
  permission delete = project.admin or folder.delete`,
  )
  .replace(
    `definition document {`,
    `definition folder {
  relation project: project via contains

  permission read = project.read
  permission write = project.write
  permission delete = project.admin
}

definition document {`,
  );

/**
 * Same workload with a counting proxy: version reads delta measures the
 * Phase 7 one-read-per-batch saving — check() reads per item, checkBatch()
 * once per chunk — as a number rather than an assertion.
 */
function withVersionCounter(store) {
  let versionReads = 0;
  const proxy = Object.create(store);
  proxy.getRelationshipVersion = async () => {
    versionReads += 1;
    return store.getRelationshipVersion();
  };
  return { store: proxy, versions: () => versionReads, resetVersions: () => (versionReads = 0) };
}

/** Build a deep org -> projects -> folders -> documents graph of the requested size. */
function buildDeepGraph(orgCount, projectsPerOrg, foldersPerProject, docsPerFolder) {
  const rels = [];
  for (let o = 0; o < orgCount; o += 1) {
    const org = `organization:org_${o}`;
    for (let u = 0; u < 4; u += 1) {
      rels.push({ subject: `user:admin_${o}_${u}`, relation: "admin", resource: org });
    }
    for (let u = 0; u < 8; u += 1) {
      rels.push({ subject: `user:member_${o}_${u}`, relation: "member", resource: org });
    }
    for (let p = 0; p < projectsPerOrg; p += 1) {
      const proj = `project:proj_${o}_${p}`;
      rels.push({ subject: org, relation: "owns", resource: proj });
      rels.push({ subject: `user:member_${o}_0`, relation: "owner", resource: proj });
      rels.push({ subject: `user:member_${o}_1`, relation: "editor", resource: proj });
      rels.push({ subject: `user:member_${o}_2`, relation: "viewer", resource: proj });
      for (let f = 0; f < foldersPerProject; f += 1) {
        // Direct project membership decides half the folders: members_0/1
        // reach their documents through the deep folder path, all others
        // only through the shallow project path.
        const deep = f % 2 === 0;
        const folder = `folder:fold_${o}_${p}_${f}`;
        rels.push({ subject: proj, relation: "contains", resource: folder });
        for (let d = 0; d < docsPerFolder; d += 1) {
          const doc = `document:doc_${o}_${p}_${f}_${d}`;
          if (deep) rels.push({ subject: folder, relation: "contains", resource: doc });
          else rels.push({ subject: proj, relation: "contains", resource: doc });
        }
        // Even folders are member-governed (owner/member_0 reach through the
        // deep path); odd folders inherit from the project via the owning
        // org — both policy levels stay exercised.
        if (deep) {
          rels.push({ subject: `user:member_${o}_0`, relation: "owner", resource: folder });
          rels.push({ subject: `user:member_${o}_1`, relation: "editor", resource: folder });
        }
      }
    }
  }
  return rels;
}

/** Build a synthetic org -> projects -> documents graph of the requested size. */
function buildGraph(orgCount, projectsPerOrg, docsPerProject) {
  const rels = [];
  for (let o = 0; o < orgCount; o += 1) {
    const org = `organization:org_${o}`;
    for (let u = 0; u < 4; u += 1) {
      rels.push({ subject: `user:admin_${o}_${u}`, relation: "admin", resource: org });
    }
    for (let u = 0; u < 8; u += 1) {
      rels.push({ subject: `user:member_${o}_${u}`, relation: "member", resource: org });
    }
    for (let p = 0; p < projectsPerOrg; p += 1) {
      const proj = `project:proj_${o}_${p}`;
      rels.push({ subject: org, relation: "owns", resource: proj });
      rels.push({ subject: `user:member_${o}_0`, relation: "owner", resource: proj });
      rels.push({ subject: `user:member_${o}_1`, relation: "editor", resource: proj });
      rels.push({ subject: `user:member_${o}_2`, relation: "viewer", resource: proj });
      for (let d = 0; d < docsPerProject; d += 1) {
        rels.push({ subject: proj, relation: "contains", resource: `document:doc_${o}_${p}_${d}` });
      }
    }
  }
  return rels;
}

/**
 * Build the stores a workload runs against.
 *
 * Both backends are handed to the evaluator through the same core interfaces, so
 * the benchmark measures the *store*, not two different engines: the only
 * difference between the two arms is where the relationships live.
 */
async function makeStores(backend, relationships, policySource = POLICY) {
  if (backend === "postgres") return makePostgresStores(relationships, policySource);

  const policyStore = new InMemoryPolicyStore();
  const v = await policyStore.publishPolicy({ source: policySource, format: "text" });
  policyStore.setActiveVersion(v.version);
  const relStore = new InMemoryRelationshipStore();
  relStore.addAll(relationships);
  return { policyStore, relStore, close: async () => {} };
}

/**
 * The same graph, loaded into PostgreSQL.
 *
 * The table is truncated first so repeated runs measure the same data volume
 * rather than accumulating every run's rows — otherwise run N would be slower
 * than run 1 for reasons that have nothing to do with the store.
 */
async function makePostgresStores(relationships, policySource = POLICY) {
  const {
    PostgresPolicyStore,
    PostgresRelationshipStore,
    PostgresRelationshipWriter,
    createPgQueryable,
    runMigrations,
  } = await import("../packages/persistence/dist/index.js");

  const db = createPgQueryable({ connectionString: PG_URL, max: 10 });
  await runMigrations(db);
  await db.query("TRUNCATE relationships");
  const writer = new PostgresRelationshipWriter(db);
  // One transaction for the whole graph: a benchmark seeded in batches would
  // spend its startup in commit round-trips and time the wrong thing.
  for (let i = 0; i < relationships.length; i += 500) {
    await writer.addBatch(relationships.slice(i, i + 500));
  }

  const policyStore = new PostgresPolicyStore(db, { environment: "bench" });
  const v = await policyStore.publishPolicy({ source: policySource, format: "text" });
  await policyStore.setActiveVersion(v.version);

  return {
    policyStore,
    relStore: new PostgresRelationshipStore(db),
    close: () => db.end(),
  };
}

function stats(values) {
  if (values.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    mean: values.reduce((s, n) => s + n, 0) / values.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

async function runWorkload({
  label,
  backend,
  orgCount,
  projectsPerOrg,
  docsPerProject,
  checks,
  // Large-policy workloads: a wider clause set plus an extra hierarchy level,
  // exercising traversal depth and clause fan-out beyond the Acme baseline.
  foldersPerProject = 0,
  policySource = POLICY,
}) {
  const deep = foldersPerProject > 0;
  const relationships = deep
    ? buildDeepGraph(orgCount, projectsPerOrg, foldersPerProject, docsPerProject)
    : buildGraph(orgCount, projectsPerOrg, docsPerProject);
  const { policyStore, relStore, close } = await makeStores(backend, relationships, policySource);
  const instrumented = new InstrumentedRelationshipStore(
    relStore.asRelationshipStore?.() ?? relStore,
  );
  // Stage profiling (completing Phase 7): the uncached arm aggregates observer
  // elapsedMs per stage, so each workload reports where check time goes —
  // normalize, policy load, decision — with no engine changes. A versioned
  // proxy counts version reads separately for the batch arm below.
  const stageTotals = new Map();
  const profiled = new Evaluator({
    policyStore,
    relationshipStore: instrumented,
    limits: { maxTraversalDepth: 12, maxVisitedNodes: 20000 },
    observer: (event) => {
      if (event.elapsedMs !== undefined) {
        stageTotals.set(event.stage, (stageTotals.get(event.stage) ?? 0) + event.elapsedMs);
      }
    },
  });
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: instrumented,
    limits: { maxTraversalDepth: 12, maxVisitedNodes: 20000 },
  });

  // One request generator shared by every arm (Phase 7): the cached and
  // uncached arms must see an identical request stream or the comparison
  // measures something else.
  const requestAt = (i) => {
    const o = i % orgCount;
    const p = Math.floor(i / orgCount) % projectsPerOrg;
    // Deep workloads address documents through their folders; shallow
    // workloads address project documents directly. Either way the generator
    // stays deterministic and shared by every arm.
    if (!deep) {
      const d = Math.floor(i / (orgCount * projectsPerOrg)) % docsPerProject;
      return {
        subject: `user:member_${o}_${(i % 3) + 1}`,
        action: "document.read",
        resource: `document:doc_${o}_${p}_${d}`,
      };
    }
    const f = Math.floor(i / orgCount) % foldersPerProject;
    const d = Math.floor(i / (orgCount * foldersPerProject)) % docsPerProject;
    return {
      subject: `user:member_${o}_${(i % 3) + 1}`,
      action: "document.read",
      resource: `document:doc_${o}_${p}_${f}_${d}`,
    };
  };
  // A second stream for the relationship-cache arm (ADR-0023): every request
  // is a distinct (subject, resource) pair, so the decision cache — which
  // collapses exact repeats — has nothing to contribute and the measured
  // difference isolates the query cache. Members 3-7 reach documents only
  // through organization membership, so each probe still walks
  // org -> project -> document: the shared sub-traversals the cache exists
  // to collapse.
  const requestAtDistinct = (i) => {
    const o = i % orgCount;
    const n = Math.floor(i / orgCount);
    const subjectSlot = n % 8;
    if (!deep) {
      const docSlot = Math.floor(n / 8) % (projectsPerOrg * docsPerProject);
      const p = Math.floor(docSlot / docsPerProject);
      const d = docSlot % docsPerProject;
      return {
        subject: `user:member_${o}_${subjectSlot}`,
        action: "document.read",
        resource: `document:doc_${o}_${p}_${d}`,
      };
    }
    const docSlot = Math.floor(n / 8) % (projectsPerOrg * foldersPerProject * docsPerProject);
    const p = Math.floor(docSlot / (foldersPerProject * docsPerProject));
    const f = Math.floor(docSlot / docsPerProject) % foldersPerProject;
    const d = docSlot % docsPerProject;
    return {
      subject: `user:member_${o}_${subjectSlot}`,
      action: "document.read",
      resource: `document:doc_${o}_${p}_${f}_${d}`,
    };
  };

  // Warm-up: the first Postgres check pays connection setup and a cold buffer
  // cache. Measuring that would report pool acquisition as query latency and
  // make the persistent backend look worse than it is.
  for (let i = 0; i < Math.min(50, checks); i += 1) {
    await evaluator.check({
      subject: `user:member_${i % orgCount}_0`,
      action: "document.read",
      resource: deep ? `document:doc_${i % orgCount}_0_0_0` : `document:doc_${i % orgCount}_0_0`,
    });
  }

  /** Run `count` checks through `target`, recording latency and store load. */
  const measure = async (target, count, reqAt = requestAt) => {
    instrumented.reset();
    const latencies = [];
    const decisions = { allow: 0, deny: 0 };
    for (let i = 0; i < count; i += 1) {
      const t0 = performance.now();
      const decision = await target.check(reqAt(i));
      latencies.push(performance.now() - t0);
      if (decision.allowed) decisions.allow += 1;
      else decisions.deny += 1;
    }
    return { report: instrumented.report(), lat: stats(latencies), decisions };
  };

  const { report, lat, decisions } = await measure(profiled, checks);
  const queriesPerCheck = report.totalCalls / checks;
  console.log(
    `\n[${label}/${backend}] orgs=${orgCount} projects/org=${projectsPerOrg} ` +
      `docs/project=${docsPerProject}${deep ? ` folders/project=${foldersPerProject}` : ""} ` +
      `rels=${relationships.length} checks=${checks}${deep ? " policy=large" : ""}`,
  );
  console.log(`  decisions: allow=${decisions.allow} deny=${decisions.deny}`);
  console.log(
    `  check latency ms: mean=${lat.mean.toFixed(3)} p50=${lat.p50.toFixed(3)} ` +
      `p95=${lat.p95.toFixed(3)} max=${lat.max.toFixed(3)}`,
  );
  console.log(`  store queries: total=${report.totalCalls} perCheck=${queriesPerCheck.toFixed(2)}`);
  // Observer stage totals are in wall-clock ms across the whole arm — shares,
  // not precision timings — so read them as "where check time goes".
  const stageEntries = [...stageTotals.entries()];
  if (stageEntries.length > 0) {
    const stageGrand = stageEntries.reduce((sum, [, total]) => sum + total, 0);
    const stageCells = stageEntries
      .sort((a, b) => b[1] - a[1])
      .map(
        ([stage, total]) =>
          `${stage}=${total.toFixed(1)}ms (${stageGrand > 0 ? ((total * 100) / stageGrand).toFixed(0) : "0"}%)`,
      );
    console.log(`  stage profile: ${stageCells.join("  ")}`);
  }
  for (const [shape, s] of Object.entries(report.byShape)) {
    if (s.calls === 0) continue;
    const p = percentiles(s);
    const avgMs = s.totalMs / s.calls;
    console.log(
      `    ${shape.padEnd(24)} calls=${String(s.calls).padStart(7)} avgMs=${avgMs.toFixed(4)} ` +
        `resultSize mean=${p.mean.toFixed(2)} p50=${p.p50} p95=${p.p95} max=${p.max}`,
    );
  }
  // Phase 7: same stores, same request stream, with the version-keyed cache
  // (ADR-0021). "cold" is the first pass over a fresh cache — misses pay a
  // version read plus a full evaluation — and "warm" is the steady state where
  // every request repeats earlier state. The gap between them is the cache's
  // value; the cold pass is its cost.
  const cache = new DecisionCache({ maxEntries: 100_000, ttlMs: 3_600_000 });
  const cachedEvaluator = new Evaluator({
    policyStore,
    relationshipStore: instrumented,
    limits: { maxTraversalDepth: 12, maxVisitedNodes: 20000 },
    decisionCache: cache,
  });
  const mark = cache.stats();
  const cold = await measure(cachedEvaluator, checks);
  const afterCold = cache.stats();
  const warm = await measure(cachedEvaluator, checks);
  const afterWarm = cache.stats();
  const hitRate = (a, b) => {
    const h = b.hits - a.hits;
    const m = b.misses - a.misses;
    return h + m === 0 ? 0 : (h * 100) / (h + m);
  };
  const coldHit = hitRate(mark, afterCold);
  const warmHit = hitRate(afterCold, afterWarm);
  console.log(
    `  cache cold pass: hitRate=${coldHit.toFixed(1)}% ` +
      `queries/check=${(cold.report.totalCalls / checks).toFixed(2)} ` +
      `p95=${cold.lat.p95.toFixed(3)}ms`,
  );
  console.log(
    `  cache warm pass: hitRate=${warmHit.toFixed(1)}% ` +
      `queries/check=${(warm.report.totalCalls / checks).toFixed(2)} ` +
      `p95=${warm.lat.p95.toFixed(3)}ms entries=${afterWarm.size} evictions=${afterWarm.evictions}`,
  );
  // ADR-0023: the relationship query cache, isolated from the decision cache
  // by the distinct stream — no request repeats, so every store query avoided
  // here is shared sub-traversal collapsing *within* checks, not across them.
  // The two arms share the instrumented store and the request generator, as
  // everywhere else in this harness.
  const relCacheEvaluator = new Evaluator({
    policyStore,
    relationshipStore: instrumented,
    limits: { maxTraversalDepth: 12, maxVisitedNodes: 20000 },
    relationshipCache: { maxEntries: 100_000, ttlMs: 3_600_000 },
  });
  const distinctPlain = await measure(evaluator, checks, requestAtDistinct);
  const distinctCached = await measure(relCacheEvaluator, checks, requestAtDistinct);
  const relStats = relCacheEvaluator.relationshipCache?.stats();
  const relHitRate =
    relStats === undefined || relStats.hits + relStats.misses === 0
      ? 0
      : (relStats.hits * 100) / (relStats.hits + relStats.misses);
  console.log(
    `  distinct uncached:          queries/check=${(distinctPlain.report.totalCalls / checks).toFixed(2)} ` +
      `p95=${distinctPlain.lat.p95.toFixed(3)}ms`,
  );
  console.log(
    `  distinct + relationshipCache: hitRate=${relHitRate.toFixed(1)}% ` +
      `queries/check=${(distinctCached.report.totalCalls / checks).toFixed(2)} ` +
      `p95=${distinctCached.lat.p95.toFixed(3)}ms entries=${relStats?.size ?? 0} evictions=${relStats?.evictions ?? 0}`,
  );
  // Batch arm (completing Phase 7): the same request stream through N x check
  // versus checkBatch chunked at maxBatchSize, over a store that counts
  // version reads. Single checks pay one version read per item; batched
  // checks pay one per chunk — same decisions, N-1 fewer reads per chunk.
  const batchCap = 100;
  const counted = withVersionCounter(instrumented);
  const batchEvaluator = new Evaluator({
    policyStore,
    relationshipStore: counted.store,
    limits: { maxTraversalDepth: 12, maxVisitedNodes: 20000 },
    decisionCache: new DecisionCache({ maxEntries: 100_000, ttlMs: 3_600_000 }),
  });
  const batchRequests = Array.from({ length: checks }, (_, i) => requestAt(i));
  // Single checks, for the version-read baseline of this stream.
  counted.resetVersions();
  instrumented.reset();
  const singleLat = [];
  const singleDecisions = [];
  for (const request of batchRequests) {
    const t0 = performance.now();
    singleDecisions.push(await batchEvaluator.check(request));
    singleLat.push(performance.now() - t0);
  }
  const singleVersionReads = counted.versions();
  const singleReport = instrumented.report();
  // Batched checks over the identical stream, one version read per chunk.
  counted.resetVersions();
  instrumented.reset();
  const batchLat = [];
  const batchDecisions = [];
  for (let i = 0; i < batchRequests.length; i += batchCap) {
    const chunk = batchRequests.slice(i, i + batchCap);
    const t0 = performance.now();
    batchDecisions.push(...(await batchEvaluator.checkBatch(chunk)));
    batchLat.push(performance.now() - t0);
  }
  const batchVersionReads = counted.versions();
  const batchReport = instrumented.report();
  const batchMatches =
    batchDecisions.length === singleDecisions.length &&
    batchDecisions.every((decision, i) => decision.allowed === singleDecisions[i]?.allowed);
  const perCheck = (latencies) => stats(latencies.map((ms) => ms / batchCap)).mean;
  console.log(
    `  batch: singles versionReads=${singleVersionReads} queries/check=${(singleReport.totalCalls / checks).toFixed(2)} ` +
      `mean/check=${stats(singleLat).mean.toFixed(3)}ms`,
  );
  console.log(
    `  batch: chunked(${batchCap})    versionReads=${batchVersionReads} queries/check=${(batchReport.totalCalls / checks).toFixed(2)} ` +
      `mean/check=${perCheck(batchLat).toFixed(3)}ms decisionsMatch=${batchMatches}`,
  );
  await close();
  return {
    backend,
    queriesPerCheck,
    lat,
    cached: {
      coldHit,
      warmHit,
      queriesPerCheck: warm.report.totalCalls / checks,
      lat: warm.lat,
    },
    relationship: {
      plainQueriesPerCheck: distinctPlain.report.totalCalls / checks,
      cachedQueriesPerCheck: distinctCached.report.totalCalls / checks,
      hitRate: relHitRate,
      lat: distinctCached.lat,
    },
    batch: {
      singleVersionReads,
      batchVersionReads,
      decisionsMatch: batchMatches,
      chunkTotal: checks,
    },
  };
}

const WORKLOADS = [
  { label: "small", orgCount: 4, projectsPerOrg: 4, docsPerProject: 4, checks: 400 },
  { label: "medium", orgCount: 16, projectsPerOrg: 6, docsPerProject: 6, checks: 1200 },
  { label: "deep-fanout", orgCount: 8, projectsPerOrg: 8, docsPerProject: 20, checks: 1600 },
  {
    label: "large-policy",
    orgCount: 8,
    projectsPerOrg: 6,
    foldersPerProject: 4,
    docsPerProject: 6,
    checks: 1200,
    policySource: POLICY_LARGE,
  },
];

async function main() {
  console.log("Universal Authorization Engine — Phase 6 access-pattern benchmark");
  const backends = PG_URL === undefined ? ["memory"] : ["memory", "postgres"];
  if (PG_URL === undefined) {
    console.log(
      `Store: in-memory reference implementation. Set ${PG_URL_ENV} to also measure ` +
        "PostgreSQL with the identical harness.",
    );
  } else {
    console.log("Stores: in-memory reference and PostgreSQL, same evaluator, same data.");
  }

  const results = [];
  for (const backend of backends) {
    for (const workload of WORKLOADS) {
      results.push({ label: workload.label, ...(await runWorkload({ backend, ...workload })) });
    }
  }

  console.log("\nSummary (queries per check, p95 check ms):");
  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(12)} ${r.backend.padEnd(9)} queries/check=${r.queriesPerCheck.toFixed(2)} ` +
        `p95=${r.lat.p95.toFixed(3)}ms`,
    );
    if (r.cached !== undefined) {
      console.log(
        `  ${"".padEnd(12)} ${"".padEnd(9)} cached(warm) hitRate=${r.cached.warmHit.toFixed(1)}% ` +
          `queries/check=${r.cached.queriesPerCheck.toFixed(2)} p95=${r.cached.lat.p95.toFixed(3)}ms`,
      );
    }
    if (r.relationship !== undefined) {
      console.log(
        `  ${"".padEnd(12)} ${"".padEnd(9)} distinct(relcache) hitRate=${r.relationship.hitRate.toFixed(1)}% ` +
          `queries/check ${r.relationship.plainQueriesPerCheck.toFixed(2)} -> ` +
          `${r.relationship.cachedQueriesPerCheck.toFixed(2)} p95=${r.relationship.lat.p95.toFixed(3)}ms`,
      );
    }
    if (r.batch !== undefined) {
      console.log(
        `  ${"".padEnd(12)} ${"".padEnd(9)} batch versionReads/check ${(r.batch.singleVersionReads / r.batch.chunkTotal).toFixed(2)} -> ` +
          `${(r.batch.batchVersionReads / r.batch.chunkTotal).toFixed(2)} decisionsMatch=${r.batch.decisionsMatch}`,
      );
    }
  }

  // The claim ADR-0017 rests on is that the query *count* is a property of the
  // evaluator, not of the store. Comparing the two backends is what makes that
  // a measurement rather than an assertion.
  if (backends.length === 2) {
    console.log("\nBackend comparison (postgres vs memory):");
    for (const { label } of WORKLOADS) {
      const memory = results.find((r) => r.label === label && r.backend === "memory");
      const pg = results.find((r) => r.label === label && r.backend === "postgres");
      if (memory === undefined || pg === undefined) continue;
      const ratio = pg.lat.p95 / memory.lat.p95;
      console.log(
        `  ${label.padEnd(12)} p95 overhead x${ratio.toFixed(1)}  ` +
          `queries/check ${memory.queriesPerCheck.toFixed(2)} -> ${pg.queriesPerCheck.toFixed(2)}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
