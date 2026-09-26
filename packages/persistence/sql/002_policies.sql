-- Policy storage (Phase 6, ADR-0017).
--
-- * Policies are immutable, content-addressed artifacts. `hash` is UNIQUE so a
--   republish of identical content is detectable, while every publish still
--   produces a distinct `version` (ADR-0018 S8) — versions are the unit of
--   audit and rollback, not content.
-- * Activation lives in a separate `policy_deployments` table. Publishing and
--   activating are different acts (ADR-0018 S7): a publish must never change
--   what a running data plane evaluates.
-- * `environment` supports staged rollout (staging v19 / production v18).

CREATE TABLE IF NOT EXISTS policies (
  version     text PRIMARY KEY,
  hash        text NOT NULL UNIQUE,
  artifact    jsonb NOT NULL,
  warnings    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The active version per environment. One row per environment (enforced by the
-- primary key), so activation is an upsert and never an implicit side effect.
CREATE TABLE IF NOT EXISTS policy_deployments (
  environment   text PRIMARY KEY,
  version       text NOT NULL REFERENCES policies (version),
  activated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policies_hash_idx ON policies (hash);
