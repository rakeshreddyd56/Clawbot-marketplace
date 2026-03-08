-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005: Additional tables for PgStore persistence
--
-- Creates tables for domain entities that were missing from the initial schema
-- but are required by the in-memory Store interface:
--   - task_scope_manifests (TaskScopeManifest)
--   - execution_sessions (ExecutionSession)
--   - data_grants (DataGrant)
--   - evidence_packs (EvidencePack)
--   - reputation_scores (ReputationScore)
--   - policy_decisions (PolicyDecision)
--   - processed_webhook_events (idempotency set for Stripe webhooks)
--
-- TASK-HARD-003: PostgreSQL persistence layer
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Task Scope Manifests ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_scope_manifests (
  scope_manifest_id    TEXT PRIMARY KEY,
  allowed_data_refs    JSONB NOT NULL DEFAULT '[]',
  allowed_tools        JSONB NOT NULL DEFAULT '[]',
  egress_allowlist     JSONB NOT NULL DEFAULT '[]',
  deliverable_schema_ref TEXT NOT NULL,
  acceptance_tests_ref TEXT NOT NULL,
  classification       TEXT NOT NULL DEFAULT 'high',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Execution Sessions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS execution_sessions (
  execution_id     TEXT PRIMARY KEY,
  contract_id      TEXT NOT NULL,
  milestone_id     TEXT NOT NULL,
  sandbox_id       TEXT NOT NULL,
  policy_version   TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'RUNNING',
  started_at       TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_execution_sessions_contract
  ON execution_sessions (contract_id, milestone_id);
CREATE INDEX IF NOT EXISTS idx_execution_sessions_state
  ON execution_sessions (state);

-- ── Data Grants ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_grants (
  grant_id         TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  worker_agent_id  TEXT NOT NULL,
  data_ref         TEXT NOT NULL,
  lease_id         TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_grants_task_id ON data_grants (task_id);
CREATE INDEX IF NOT EXISTS idx_data_grants_worker ON data_grants (worker_agent_id);

-- ── Evidence Packs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evidence_packs (
  evidence_pack_id TEXT PRIMARY KEY,
  dispute_id       TEXT NOT NULL,
  contract_id      TEXT NOT NULL,
  artifact_ids     JSONB NOT NULL DEFAULT '[]',
  event_ids        JSONB NOT NULL DEFAULT '[]',
  generated_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_packs_dispute ON evidence_packs (dispute_id);

-- ── Reputation Scores ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reputation_scores (
  agent_id         TEXT PRIMARY KEY,
  score            INTEGER NOT NULL DEFAULT 700,
  factors          JSONB NOT NULL DEFAULT '{}',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Policy Decisions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_decisions (
  decision_id      TEXT PRIMARY KEY,
  policy_version   TEXT NOT NULL,
  action           TEXT NOT NULL,
  actor_agent_id   TEXT NOT NULL,
  entity_id        TEXT,
  allow            BOOLEAN NOT NULL,
  reason           TEXT NOT NULL,
  context_hash     TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policy_decisions_actor
  ON policy_decisions (actor_agent_id);
CREATE INDEX IF NOT EXISTS idx_policy_decisions_created_at
  ON policy_decisions (created_at DESC);

-- ── Processed Webhook Events (idempotency) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id         TEXT PRIMARY KEY,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Task Milestone Names (separate table to match Store interface) ──────────
-- The tasks table already has milestone_names JSONB, but the Store has a
-- separate Map<string, string[]> keyed by taskId. We use the tasks table column.
-- No separate table needed — handled via tasks.milestone_names JSONB column.

COMMIT;
