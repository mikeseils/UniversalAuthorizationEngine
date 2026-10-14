-- Policy storage (Phase 6, ADR-0017; S8 fix per ADR-0018).
--
-- * Policies are immutable, content-addressed artifacts. `hash` is deliberately
--   NOT unique: S8 requires every publish to mint a DISTINCT version even for
--   identical content (versions are the unit of audit and rollback, not
--   content). 002 originally declared it UNIQUE, which raised 23505 on
--   republish instead of minting a new version. Content-addressing is the
--   `hash` column value itself, not a uniqueness constraint.
-- * Activation lives in a separate `policy_deployments` table. Publishing and
--   activating are different acts (ADR-0018 S7): a publish must never change
--   what a running data plane evaluates.
-- * Version allocation is the `policy_versions` sequence (below), never a
--   per-instance counter: two store instances sharing one database must not be
--   able to mint the same version.
-- * `environment` supports staged rollout (staging v19 / production v18).

-- One immutable artifact per version. `hash` is indexed, never unique.
CREATE TABLE IF NOT EXISTS policies (
  version     text PRIMARY KEY,
  hash        text NOT NULL,
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

-- Version allocation (ADR-0018 S8): every publish must mint a DISTINCT version
-- even for identical content, and distinct store instances sharing one
-- database must never collide on a per-instance counter. The sequence is the
-- authority — `publishPolicy` inserts `nextval('policy_versions')::text`.
CREATE SEQUENCE IF NOT EXISTS policy_versions START WITH 1;

-- S8 repair for databases migrated with the original 002 (which declared
-- `hash` UNIQUE): drop the constraint if present, then keep the lookup index.
-- Idempotent — safe to re-run on fresh and migrated databases alike.
ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_hash_key;
CREATE INDEX IF NOT EXISTS policies_hash_idx ON policies (hash);
