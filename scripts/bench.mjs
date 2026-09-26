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
 * latency. Dependency-free; runs against the in-memory store, and the same
 * harness runs against a persistent store so the two are directly comparable.
 */

import {
  Evaluator,
  InMemoryRelationshipStore,
  InstrumentedRelationshipStore,
  percentiles,
} from "../packages/evaluator/dist/index.js";
import { InMemoryPolicyStore } from "../packages/policy/dist/index.js";

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

async function makeEvaluator(relationships) {
  const policyStore = new InMemoryPolicyStore();
  const v = await policyStore.publishPolicy({ source: POLICY, format: "text" });
  policyStore.setActiveVersion(v.version);
  const relStore = new InMemoryRelationshipStore();
  relStore.addAll(relationships);
  return { policyStore, relStore };
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

async function runWorkload({ label, orgCount, projectsPerOrg, docsPerProject, checks }) {
  const relationships = buildGraph(orgCount, projectsPerOrg, docsPerProject);
  const { policyStore, relStore } = await makeEvaluator(relationships);
  const instrumented = new InstrumentedRelationshipStore(relStore.asRelationshipStore());
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: instrumented,
    limits: { maxTraversalDepth: 12, maxVisitedNodes: 20000 },
  });

  for (let i = 0; i < Math.min(50, checks); i += 1) {
    await evaluator.check({
      subject: `user:member_${i % orgCount}_0`,
      action: "document.read",
      resource: `document:doc_${i % orgCount}_0_0`,
    });
  }

  instrumented.reset();
  const latencies = [];
  const decisions = { allow: 0, deny: 0 };
  for (let i = 0; i < checks; i += 1) {
    const o = i % orgCount;
    const p = Math.floor(i / orgCount) % projectsPerOrg;
    const d = Math.floor(i / (orgCount * projectsPerOrg)) % docsPerProject;
    const t0 = performance.now();
    const decision = await evaluator.check({
      subject: `user:member_${o}_${(i % 3) + 1}`,
      action: "document.read",
      resource: `document:doc_${o}_${p}_${d}`,
    });
    latencies.push(performance.now() - t0);
    if (decision.allowed) decisions.allow += 1;
    else decisions.deny += 1;
  }

  const report = instrumented.report();
  const lat = stats(latencies);
  const queriesPerCheck = report.totalCalls / checks;
  console.log(
    `\n[${label}] orgs=${orgCount} projects/org=${projectsPerOrg} ` +
      `docs/project=${docsPerProject} rels=${relationships.length} checks=${checks}`,
  );
  console.log(`  decisions: allow=${decisions.allow} deny=${decisions.deny}`);
  console.log(
    `  check latency ms: mean=${lat.mean.toFixed(3)} p50=${lat.p50.toFixed(3)} ` +
      `p95=${lat.p95.toFixed(3)} max=${lat.max.toFixed(3)}`,
  );
  console.log(`  store queries: total=${report.totalCalls} perCheck=${queriesPerCheck.toFixed(2)}`);
  for (const [shape, s] of Object.entries(report.byShape)) {
    if (s.calls === 0) continue;
    const p = percentiles(s);
    const avgMs = s.totalMs / s.calls;
    console.log(
      `    ${shape.padEnd(24)} calls=${String(s.calls).padStart(7)} avgMs=${avgMs.toFixed(4)} ` +
        `resultSize mean=${p.mean.toFixed(2)} p50=${p.p50} p95=${p.p95} max=${p.max}`,
    );
  }
  return { queriesPerCheck, lat };
}

async function main() {
  console.log("Universal Authorization Engine — Phase 6 access-pattern benchmark");
  console.log(
    "Store: in-memory reference implementation (Postgres compared in the persistence phase).",
  );
  const results = [];
  results.push(
    await runWorkload({
      label: "small",
      orgCount: 4,
      projectsPerOrg: 4,
      docsPerProject: 4,
      checks: 400,
    }),
  );
  results.push(
    await runWorkload({
      label: "medium",
      orgCount: 16,
      projectsPerOrg: 6,
      docsPerProject: 6,
      checks: 1200,
    }),
  );
  results.push(
    await runWorkload({
      label: "deep-fanout",
      orgCount: 8,
      projectsPerOrg: 8,
      docsPerProject: 20,
      checks: 1600,
    }),
  );
  console.log("\nSummary (queries per check, p95 check ms):");
  for (const [i, r] of results.entries()) {
    console.log(
      `  workload#${i + 1}: queries/check=${r.queriesPerCheck.toFixed(2)} p95=${r.lat.p95.toFixed(3)}ms`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
