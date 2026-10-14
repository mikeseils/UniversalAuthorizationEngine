import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ActivatablePolicyStore,
  AuthorizationRequest,
  PolicySource,
} from "../packages/core/src/index.js";
import {
  InMemoryPolicyStore,
  StructuredPolicy,
  anyOf,
  contextEquals,
  indirectRef,
  relationRef,
} from "../packages/policy/src/index.js";
import { Evaluator, InMemoryRelationshipStore } from "../packages/evaluator/src/index.js";
import { ACME_RELATIONSHIPS, parseFixtureLine } from "../examples/acme/fixture.js";

/** Acme structured policy matching docs/design/domain-model.md. */
export const ACME_POLICY: StructuredPolicy = {
  definitions: {
    organization: {
      relations: {
        admin: { subjectTypes: ["user"] },
        member: { subjectTypes: ["user"] },
      },
      permissions: {
        manage: anyOf(relationRef("admin")),
        read: anyOf(relationRef("admin"), relationRef("member")),
      },
    },
    project: {
      relations: {
        owner: { subjectTypes: ["user"] },
        editor: { subjectTypes: ["user"] },
        viewer: { subjectTypes: ["user"] },
      },
      permissions: {
        read: anyOf(
          relationRef("viewer"),
          relationRef("editor"),
          relationRef("owner"),
          indirectRef("owns", "read", true),
        ),
        write: anyOf(relationRef("editor"), relationRef("owner")),
        delete: anyOf(relationRef("owner"), indirectRef("owns", "manage", true)),
      },
    },
    document: {
      relations: {},
      permissions: {
        read: anyOf(indirectRef("contains", "read", true)),
        delete: anyOf(indirectRef("contains", "delete", true)),
      },
    },
  },
};

/** Approval policy exercising context conditions. */
export const APPROVAL_POLICY: StructuredPolicy = {
  definitions: {
    invoice: {
      relations: { approver: { subjectTypes: ["user"] } },
      contextSchema: { mfa: "boolean" },
      permissions: {
        approve: {
          kind: "and",
          operands: [relationRef("approver"), contextEquals("mfa", true)],
        },
      },
    },
  },
};

export interface AcmeSetup {
  policyStore: InMemoryPolicyStore;
  relationships: InMemoryRelationshipStore;
  evaluator: Evaluator;
  /** The policy source this setup is configured to publish. */
  policy: PolicySource;
}

/**
 * Build the canonical Acme scenario: relationships from the fixture plus an
 * evaluator wired to fresh stores. The policy is not published here — call
 * {@link publishAndActivate} with the same setup so the source can be text
 * (ADR-0012) or structured, and both reach the identical publish path.
 */
export function acmeSetup(policy: PolicySource = { source: ACME_POLICY }): AcmeSetup {
  const policyStore = new InMemoryPolicyStore();
  const relationships = new InMemoryRelationshipStore();
  relationships.addAll(
    ACME_RELATIONSHIPS.map((line) => {
      const p = parseFixtureLine(line);
      return { subject: p.subject, relation: p.relation, resource: p.resource };
    }),
  );
  const evaluator = new Evaluator({
    policyStore,
    relationshipStore: relationships.asRelationshipStore(),
  });
  return { policyStore, relationships, evaluator, policy };
}

/**
 * Publish + activate a policy source, returning the active version string.
 *
 * Takes the core control-plane view (ADR-0018 S7), not the in-memory class, so
 * the helpers work for any backend and `await`ing activation is type-correct
 * for both the sync reference setter and a persistent backend's async one.
 */
export async function publishAndActivate(
  store: ActivatablePolicyStore,
  policy: PolicySource = { source: ACME_POLICY },
): Promise<string> {
  const versioned = await store.publishPolicy(policy);
  await store.setActiveVersion(versioned.version);
  return versioned.version;
}

/** The canonical Acme policy written in the ADR-0012 text language. */
export function readAcmePolicyText(): string {
  return readFileSync(
    fileURLToPath(new URL("../examples/acme/policy.authz", import.meta.url)),
    "utf8",
  );
}

/** Publish policy *text* (ADR-0012) + activate it, returning the version. */
export async function publishTextAndActivate(
  store: ActivatablePolicyStore,
  text: string,
): Promise<string> {
  const versioned = await store.publishPolicy({ source: text, format: "text" });
  await store.setActiveVersion(versioned.version);
  return versioned.version;
}

export const check = (
  evaluator: Evaluator,
  subject: string,
  action: string,
  resource: string,
  context?: AuthorizationRequest["context"],
) =>
  evaluator.check(
    context !== undefined ? { subject, action, resource, context } : { subject, action, resource },
  );
