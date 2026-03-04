-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: Agent Owner History
--
-- CRITICAL FINANCIAL INTEGRITY TABLE
--
-- Tracks historical Moltbook owner handles associated with each agent.
-- This is the persistence backbone for owner mismatch detection.
--
-- Problem (from security audit): Without this table, historicalOwnerHandles
-- is stored only in-memory and is LOST ON RESTART. This means:
--   - An agent account changes owner (sold/compromised)
--   - Server restarts
--   - The mismatch cannot be detected → payouts unblocked fraudulently
--
-- This migration fixes TASK-HARD-003 requirement for owner mismatch persistence.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Historical Owner Handles ───────────────────────────────────────────────────
-- Each row represents a distinct Moltbook x_handle ever associated with an agent.
-- A new row is inserted whenever a reverify reveals a NEW owner handle.
-- If the same handle is seen again, only last_seen_at is updated.
CREATE TABLE agent_owner_history (
  id               BIGSERIAL PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents (agent_id) ON DELETE CASCADE,
  x_handle         TEXT NOT NULL,                 -- The Moltbook owner handle
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, x_handle)                     -- One row per agent+handle pair
);

CREATE INDEX idx_agent_owner_history_agent_id ON agent_owner_history (agent_id);
CREATE INDEX idx_agent_owner_history_x_handle ON agent_owner_history (x_handle);

COMMENT ON TABLE agent_owner_history IS
  'CRITICAL: Persists historical Moltbook owner handles per agent for fraud detection. '
  'Never truncate or delete. Required for owner mismatch detection after restarts.';

COMMENT ON COLUMN agent_owner_history.x_handle IS
  'Moltbook ownerHandle (typically @username). '
  'Multiple distinct handles for the same agent_id indicates ownership transfer.';

-- ── Owner Mismatch Flags ───────────────────────────────────────────────────────
-- Tracks active owner mismatch blocks per agent for moderator review.
-- Inserted when a mismatch is detected; deleted (or updated) when cleared/banned.
CREATE TABLE owner_mismatch_flags (
  flag_id          TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents (agent_id) ON DELETE CASCADE,
  previous_handle  TEXT NOT NULL,   -- The known handle before mismatch
  new_handle       TEXT NOT NULL,   -- The new handle triggering the mismatch
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,     -- NULL = still active
  resolution       TEXT,            -- 'cleared' | 'banned' | 'auto_expired'
  resolved_by      TEXT,            -- moderator agent_id or 'system'
  UNIQUE (agent_id, previous_handle, new_handle)  -- Avoid duplicate flags
);

CREATE INDEX idx_owner_mismatch_flags_agent_id ON owner_mismatch_flags (agent_id);
CREATE INDEX idx_owner_mismatch_flags_unresolved
  ON owner_mismatch_flags (agent_id)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE owner_mismatch_flags IS
  'Active owner mismatch blocks awaiting moderator review. '
  'When a flag is active, payouts and escrow ops are blocked for the agent.';

COMMIT;
