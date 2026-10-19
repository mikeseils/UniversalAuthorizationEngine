-- SCIM provisioning acts join the governance audit trail (Phase 9 SCIM).
--
-- `authz identities import` records a `provision` act whose `version` carries
-- the sentinel `scim-import`: provisioning is attributable to an actor, not to
-- a policy version, and a freshly provisioned environment has published no
-- version at all, so the foreign key from `policy_governance.version` to
-- `policies(version)` rejected every such row. The column keeps NOT NULL —
-- every audit row still answers "which version?" with a non-empty string (a
-- published version or the sentinel), so the readers (`policy-audit`,
-- `compliance-export`) stay free of null handling. `publish` and `activate`
-- acts keep inserting real versions; only the referential tie is dropped.
-- `PostgresPolicyStore.reset()` truncates `policy_governance` together with
-- `policies` anyway, so a reset store still looks freshly migrated.
--
-- Constraint names are the PostgreSQL defaults assigned by 003_governance.sql.
-- Both drops use IF EXISTS and the CHECK is re-added unconditionally, so
-- re-running this file leaves the same schema.
ALTER TABLE policy_governance DROP CONSTRAINT IF EXISTS policy_governance_version_fkey;
ALTER TABLE policy_governance DROP CONSTRAINT IF EXISTS policy_governance_action_check;
ALTER TABLE policy_governance
  ADD CONSTRAINT policy_governance_action_check
  CHECK (action IN ('publish', 'approve', 'activate', 'provision'));
