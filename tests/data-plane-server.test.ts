import { describe, expect, it } from "vitest";
import { InMemoryPolicyStore } from "../packages/policy/src/store.js";
import { Evaluator, InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import { DataPlaneServer } from "../packages/data-plane/src/server.js";
import { ACME_POLICY, APPROVAL_POLICY, publishAndActivate } from "./helpers.js";

describe("DataPlaneServer", () => {
  it("answers check requests over HTTP", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "user:member_0_0",
          action: "document.read",
          resource: "document:doc_0_0_0",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect((body as { outcome: string }).outcome).toBe("decision");
      expect((body as { decision: { allowed: boolean } }).decision.allowed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("answers checkBatch requests over HTTP", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/checkBatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { subject: "user:member_0_0", action: "document.read", resource: "document:doc_0_0_0" },
          { subject: "user:member_0_1", action: "document.read", resource: "document:doc_0_1_0" },
        ]),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("healthz returns ok", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/healthz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect((body as { status: string }).status).toBe("ok");
    } finally {
      await server.close();
    }
  });
  it("requires API key when keys are configured", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, {
      port: 0,
      apiKeys: ["secret-key-1"],
    });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "user:member_0_0",
          action: "document.read",
          resource: "document:doc_0_0_0",
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("accepts valid Bearer token", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, {
      port: 0,
      apiKeys: ["secret-key-1"],
    });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-key-1",
        },
        body: JSON.stringify({
          subject: "user:member_0_0",
          action: "document.read",
          resource: "document:doc_0_0_0",
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("accepts valid X-API-Key header", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, {
      port: 0,
      apiKeys: ["secret-key-1"],
    });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "secret-key-1",
        },
        body: JSON.stringify({
          subject: "user:member_0_0",
          action: "document.read",
          resource: "document:doc_0_0_0",
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("rejects invalid API key", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, {
      port: 0,
      apiKeys: ["secret-key-1"],
    });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-key",
        },
        body: JSON.stringify({
          subject: "user:member_0_0",
          action: "document.read",
          resource: "document:doc_0_0_0",
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("no auth required when no keys are configured", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "user:member_0_0",
          action: "document.read",
          resource: "document:doc_0_0_0",
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("rejects malformed JSON with 400, not 500", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid JSON body");
    } finally {
      await server.close();
    }
  });

  it("rejects oversized request bodies with 413", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0, maxBodyBytes: 128 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(512),
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("request body too large");
    } finally {
      await server.close();
    }
  });

  it("does not count health probes as checks", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      for (let i = 0; i < 3; i++) {
        const probe = await fetch(`http://127.0.0.1:${String(addr.port)}/healthz`);
        expect(probe.status).toBe(200);
      }
      const before = await (await fetch(`http://127.0.0.1:${String(addr.port)}/metrics`)).text();
      expect(before).toContain("uae_checks_total 0");

      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "user:member_0_0",
          action: "document.read",
          resource: "document:doc_0_0_0",
        }),
      });
      expect(res.status).toBe(200);
      const after = await (await fetch(`http://127.0.0.1:${String(addr.port)}/metrics`)).text();
      expect(after).toContain("uae_checks_total 1");
    } finally {
      await server.close();
    }
  });

  it("serves the active policy version from the provider", async () => {
    const { evaluator, policyStore } = await setup();
    const server = new DataPlaneServer(evaluator, {
      port: 0,
      policyVersion: () => policyStore.getActiveVersion(),
    });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/version`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version: string };
      expect(body.version).toBe("1");
    } finally {
      await server.close();
    }
  });

  it("fails closed on /version when no active policy exists", async () => {
    const { evaluator } = await setup();
    const noProvider = new DataPlaneServer(evaluator, { port: 0 });
    const nullProvider = new DataPlaneServer(evaluator, {
      port: 0,
      policyVersion: () => null,
    });
    await noProvider.listen();
    await nullProvider.listen();
    try {
      const noAddr = noProvider.address() as { port: number };
      const nullAddr = nullProvider.address() as { port: number };
      const resA = await fetch(`http://127.0.0.1:${String(noAddr.port)}/version`);
      expect(resA.status).toBe(503);
      const resB = await fetch(`http://127.0.0.1:${String(nullAddr.port)}/version`);
      expect(resB.status).toBe(503);
    } finally {
      await noProvider.close();
      await nullProvider.close();
    }
  });

  it("rate limits check requests with 429 while probes stay answerable", async () => {
    const { evaluator } = await setup();
    const server = new DataPlaneServer(evaluator, { port: 0, rateLimitPerMinute: 2 });
    await server.listen();
    try {
      const addr = server.address() as { port: number };
      const check = () =>
        fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: "user:member_0_0",
            action: "document.read",
            resource: "document:doc_0_0_0",
          }),
        });
      expect((await check()).status).toBe(200);
      expect((await check()).status).toBe(200);
      const limited = await check();
      expect(limited.status).toBe(429);
      const body = (await limited.json()) as { error: string };
      expect(body.error).toBe("rate limit exceeded");

      // Ops probes are outside the limiter: an overloaded data plane must
      // still answer health checks.
      const probe = await fetch(`http://127.0.0.1:${String(addr.port)}/healthz`);
      expect(probe.status).toBe(200);
      const metrics = await (await fetch(`http://127.0.0.1:${String(addr.port)}/metrics`)).text();
      expect(metrics).toContain("uae_rate_limited_total 1");
    } finally {
      await server.close();
    }
  });
});

async function setup() {
  const policyStore = new InMemoryPolicyStore();
  const relationships = new InMemoryRelationshipStore();
  relationships.add({
    subject: "organization:org_0",
    relation: "owns",
    resource: "project:proj_0_0",
  });
  relationships.add({
    subject: "organization:org_0",
    relation: "owns",
    resource: "project:proj_0_1",
  });
  relationships.add({
    subject: "user:member_0_0",
    relation: "owner",
    resource: "project:proj_0_0",
  });
  relationships.add({
    subject: "user:member_0_0",
    relation: "owner",
    resource: "project:proj_0_1",
  });
  relationships.add({
    subject: "user:member_0_1",
    relation: "editor",
    resource: "project:proj_0_0",
  });
  relationships.add({
    subject: "project:proj_0_0",
    relation: "contains",
    resource: "document:doc_0_0_0",
  });
  relationships.add({
    subject: "project:proj_0_1",
    relation: "contains",
    resource: "document:doc_0_1_0",
  });
  await publishAndActivate(policyStore, { source: ACME_POLICY });
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: relationships.asRelationshipStore(),
  });
  return { evaluator, policyStore };
}

it("rejects malformed check requests with 400", async () => {
  const { evaluator } = await setup();
  const server = new DataPlaneServer(evaluator, { port: 0 });
  await server.listen();
  try {
    const addr = server.address() as { port: number };
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    // Empty subject is malformed caller input, rejected at the boundary.
    expect(
      (await post({ subject: "", action: "document.read", resource: "document:a" })).status,
    ).toBe(400);
    // Missing action is malformed caller input.
    expect((await post({ subject: "user:alice", resource: "document:a" })).status).toBe(400);
    // Context must be an object of primitives.
    expect(
      (
        await post({
          subject: "user:alice",
          action: "document.read",
          resource: "document:a",
          context: "nope",
        })
      ).status,
    ).toBe(400);
  } finally {
    await server.close();
  }
});

it("returns 503 when /check has no active policy", async () => {
  const policyStore = new InMemoryPolicyStore();
  const relationships = new InMemoryRelationshipStore();
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: relationships.asRelationshipStore(),
  });
  const server = new DataPlaneServer(evaluator, { port: 0 });
  await server.listen();
  try {
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: "user:alice",
        action: "document.read",
        resource: "document:a",
      }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect((body as { outcome: string }).outcome).toBe("unavailable");
  } finally {
    await server.close();
  }
});

/* External identity: the engine consumes caller-supplied subject identity and
 * claims (context); it never authenticates. Claims are validated against
 * policy-declared context schemas and gate the decision (default-deny). */
it("external identity claims gate the decision", async () => {
  const policyStore = new InMemoryPolicyStore();
  const relationships = new InMemoryRelationshipStore();
  relationships.add({
    subject: "user:approver",
    relation: "approver",
    resource: "invoice:inv_1",
  });
  await publishAndActivate(policyStore, { source: APPROVAL_POLICY });
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: relationships.asRelationshipStore(),
  });
  const server = new DataPlaneServer(evaluator, { port: 0 });
  await server.listen();
  try {
    const addr = server.address() as { port: number };
    const post = (context: unknown) =>
      fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "user:approver",
          action: "invoice.approve",
          resource: "invoice:inv_1",
          ...(context === undefined ? {} : { context }),
        }),
      });
    // Caller-supplied claim satisfies the policy-declared context schema.
    expect((await (await post({ mfa: true })).json()).decision.allowed).toBe(true);
    // Missing claim -> condition not satisfied -> DENY (fail-closed).
    expect((await (await post(undefined)).json()).decision.allowed).toBe(false);
    // Wrong claim value -> DENY, never a silent ALLOW.
    expect((await (await post({ mfa: false })).json()).decision.allowed).toBe(false);
    // Type mismatch against the schema -> DENY, not 400 (policy-level).
    expect((await (await post({ mfa: "yes" })).json()).decision.allowed).toBe(false);
  } finally {
    await server.close();
  }
});

it("tenant isolation: cross-tenant subject is denied unless policy allows", async () => {
  const { evaluator } = await setup();
  const server = new DataPlaneServer(evaluator, { port: 0 });
  await server.listen();
  try {
    const addr = server.address() as { port: number };
    // member_0_1 is editor of proj_0_0 only, has no relationship to proj_0_1.
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: "user:member_0_1",
        action: "document.read",
        resource: "document:doc_0_1_0",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body as { decision: { allowed: boolean } }).decision.allowed).toBe(false);
  } finally {
    await server.close();
  }
});
