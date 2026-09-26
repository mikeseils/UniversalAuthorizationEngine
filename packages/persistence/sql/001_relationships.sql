-- Universal Authorization Engine — relationship storage (Phase 6, ADR-0017).
--
-- Design notes:
-- * The primary key IS the idempotency guarantee (ADR-0018 S5): re-adding an
--   existing relationship is an `ON CONFLICT DO NOTHING` no-op, so retried
--   writes after a network failure can never duplicate state.
-- * The two composite indexes match the only two query shapes the evaluator
--   issues (measured in ADR-0017: `subject+relation+resource` and
--   `resource+relation`). Every probe is a selective point lookup.
-- * No graph tables, no traversal tables. The evaluator walks edges; the store
--   only answers indexed lookups.

CREATE TABLE IF NOT EXISTS relationships (
  subject_type   text   NOT NULL,
  subject_id     text   NOT NULL,
  relation       text   NOT NULL,
  resource_type  text   NOT NULL,
  resource_id    text   NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relationships_pkey
    PRIMARY KEY (subject_type, subject_id, relation, resource_type, resource_id)
);

-- Forward access: "what does this subject do via this relation?"
CREATE INDEX IF NOT EXISTS relationships_subject_idx
  ON relationships (subject_type, subject_id, relation);

-- Reverse access: "who relates to this resource via this relation?"
CREATE INDEX IF NOT EXISTS relationships_resource_idx
  ON relationships (resource_type, resource_id, relation);
