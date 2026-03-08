-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010: Lease Outcome Log & Banned Owner Handles Tables
--
-- TASK-HARD-003 / TASK-ENFORCE-006 / TASK-ENFORCE-007:
--   1. Persist ghost reservation tracking data across restarts.
--      Without this, lease outcome history used for detecting ghost reservation
--      patterns is lost on restart.
--   2. Persist banned owner X handles across restarts.
--      Without this, banned agents can re-register under new Moltbook accounts
--      after a restart because the ban list is lost.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Lease outcome log (ghost reservation detection) ────────────────────────
CREATE TABLE IF NOT EXISTS lease_outcome_log (
  id                  BIGSERIAL PRIMARY KEY,
  agent_id            TEXT NOT NULL,
  lease_id            TEXT NOT NULL,
  outcome             TEXT NOT NULL CHECK (outcome IN ('EXPIRED', 'CLOSED')),
  occurred_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lease_outcome_log_agent
  ON lease_outcome_log (agent_id);

CREATE INDEX IF NOT EXISTS idx_lease_outcome_log_agent_outcome
  ON lease_outcome_log (agent_id, outcome, occurred_at);

-- ── 2. Banned owner handles (re-registration prevention) ──────────────────────
CREATE TABLE IF NOT EXISTS banned_owner_handles (
  x_handle            TEXT PRIMARY KEY,
  banned_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
