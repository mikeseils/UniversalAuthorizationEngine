import { AuthorizationRequest } from "../packages/core/src/index.js";
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
}

export function acmeSetup(_policy: StructuredPolicy = ACME_POLICY): AcmeSetup {
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
  return { policyStore, relationships, evaluator };
}

/** Publish + activate a policy, returning the active version string. */
export async function publishAndActivate(
  store: InMemoryPolicyStore,
  policy: StructuredPolicy = ACME_POLICY,
): Promise<string> {
  const versioned = await store.publishPolicy({ source: policy });
  store.setActiveVersion(versioned.version);
  return versioned.version;
}

export const check = (
  evaluator: Evaluator,
  subject: string,
  action: string,
  resource: string,
  context?: AuthorizationRequest["context"],
) => evaluator.check({ subject, action, resource, context });
