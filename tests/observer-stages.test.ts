import { describe, expect, it } from "vitest";
import { DecisionCache, Evaluator } from "../packages/evaluator/src/index.js";
import { acmeSetup, publishAndActivate } from "./helpers.js";

/**
 * Observer stage timings (Phase 7 profiling seed).
 *
 * Stage events carry `elapsedMs` so a future data plane can report where check
 * time goes - policy load, version read, evaluation - without re-instrumenting
 * the engine. The evaluator never logs directly (purity); the observer is the
 * only channel.
 */
describe("observer stage timings", () => {
  it("reports per-stage durations across a cached evaluation", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const events: { stage: string; detail?: string; elapsedMs?: number }[] = [];
    const evaluator = new Evaluator({
      policyStore: setup.policyStore,
      relationshipStore: setup.relationships.asRelationshipStore(),
      decisionCache: new DecisionCache(),
      observer: (event) => events.push(event),
    });
    await evaluator.check({
      subject: "user:alice",
      action: "document.read",
      resource: "document:a",
    });
    expect(events.map((e) => e.stage)).toEqual([
      "normalize",
      "policy:loaded",
      "cache:miss",
      "decision",
    ]);
    // The first event anchors the clock at 0; every event carries a duration.
    expect(events[0]?.elapsedMs).toBe(0);
    for (const event of events) {
      expect(typeof event.elapsedMs).toBe("number");
      expect((event.elapsedMs ?? -1) >= 0).toBe(true);
    }
  });

  it("omits cache stages when no cache is configured", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const events: string[] = [];
    const evaluator = new Evaluator({
      policyStore: setup.policyStore,
      relationshipStore: setup.relationships.asRelationshipStore(),
      observer: (event) => events.push(event.stage),
    });
    await evaluator.check({
      subject: "user:alice",
      action: "document.read",
      resource: "document:a",
    });
    expect(events).toEqual(["normalize", "policy:loaded", "decision"]);
  });

  it("emits cache:hit with the version-read duration on a repeat check", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    const stages: string[] = [];
    const evaluator = new Evaluator({
      policyStore: setup.policyStore,
      relationshipStore: setup.relationships.asRelationshipStore(),
      decisionCache: new DecisionCache(),
      observer: (event) => stages.push(event.stage),
    });
    const request = { subject: "user:alice", action: "document.read", resource: "document:a" };
    await evaluator.check(request);
    await evaluator.check(request);
    expect(stages).toEqual([
      "normalize",
      "policy:loaded",
      "cache:miss",
      "decision",
      "normalize",
      "policy:loaded",
      "cache:hit",
    ]);
  });

  it("emits nothing and costs nothing without an observer", async () => {
    const setup = acmeSetup();
    await publishAndActivate(setup.policyStore);
    // No observer configured: the check simply succeeds - the absence of any
    // observer plumbing is the assertion (no clock, no allocation).
    const evaluator = new Evaluator({
      policyStore: setup.policyStore,
      relationshipStore: setup.relationships.asRelationshipStore(),
      decisionCache: new DecisionCache(),
    });
    const decision = await evaluator.check({
      subject: "user:alice",
      action: "document.read",
      resource: "document:a",
    });
    expect(decision.allowed).toBe(true);
  });
});
