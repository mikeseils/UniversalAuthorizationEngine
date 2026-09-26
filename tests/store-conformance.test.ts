import { InMemoryPolicyStore } from "../packages/policy/src/index.js";
import {
  describePolicyStoreContract,
  describeStoreContract,
  inMemoryFixture,
} from "./store-conformance.js";

/**
 * The reference store is held to the same contract as every future backend
 * (ADR-0018). The Postgres-backed fixture is added by
 * `persistence-postgres.test.ts`, which skips cleanly when no database is
 * configured — so the default developer workflow needs no Docker.
 */
describeStoreContract(inMemoryFixture());

describePolicyStoreContract("InMemoryPolicyStore", () =>
  Promise.resolve(new InMemoryPolicyStore()),
);
