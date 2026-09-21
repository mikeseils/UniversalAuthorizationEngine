import { describe, expect, it } from "vitest";
import { acmeSetup, check, publishAndActivate } from "./helpers.js";

describe("batch checks", () => {
  it("return decisions identical to individual checks", async () => {
    const { evaluator, policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const requests = [
      { subject: "user:alice", action: "document.read", resource: "document:a" },
      { subject: "user:bob", action: "document.delete", resource: "document:a" },
      { subject: "user:carol", action: "project.read", resource: "project:alpha" },
    ] as const;
    const batch = await evaluator.checkBatch(requests.map((r) => ({ ...r })));
    const individual = [];
    for (const r of requests)
      individual.push(await check(evaluator, r.subject, r.action, r.resource));
    expect(batch).toEqual(individual);
  });

  it("a denial in the batch does not poison siblings", async () => {
    const { evaluator, policyStore } = acmeSetup();
    await publishAndActivate(policyStore);
    const decisions = await evaluator.checkBatch([
      { subject: "user:carol", action: "document.read", resource: "document:a" }, // deny
      { subject: "user:alice", action: "document.read", resource: "document:a" }, // allow
    ]);
    expect(decisions[0]?.allowed).toBe(false);
    expect(decisions[1]?.allowed).toBe(true);
  });
});
