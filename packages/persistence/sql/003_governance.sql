-- Policy governance audit trail (Phase 9).
--
-- Records every publication/deployment act on a policy so insider changes are
-- attributable: who published which version, who approved it, and who activated
-- it in which environment. Append-only by convention (never `UPDATE`/`DELETE`
-- historical rows); rotation of a compromised actor is a deployer operation
-- (see docs/operations/disaster-recovery.md).
--
-- Separation of duties (publisher != approver) is a process control enforced
-- by the operator, not by the engine: the engine owns no authentication and
-- the CLI is a local tool, so there is no caller identity to verify here. The
-- `actor` column records who performed each act for the audit trail.
CREATE TABLE IF NOT EXISTS policy_governance (
  id          bigserial PRIMARY KEY,
  environment text NOT NULL DEFAULT 'default',
  version     text NOT NULL REFERENCES policies (version),
  action      text NOT NULL CHECK (action IN ('publish', 'approve', 'activate')),
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policy_governance_version_idx ON policy_governance (version);
CREATE INDEX IF NOT EXISTS policy_governance_env_idx ON policy_governance (environment, created_at DESC);
