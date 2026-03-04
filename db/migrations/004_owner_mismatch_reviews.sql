-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Owner Mismatch Moderation Reviews
--
-- Extends migration 002 with moderation review tracking and queue management.
-- Required by TASK-HARD-012: Owner mismatch moderator review workflow.
--
-- Provides:
--   - Moderation review audit trail (who cleared/banned and when)
--   - Escalation status for multi-step review workflows
--   - Queue priority for moderator dashboard ordering
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Moderation Review Actions ──────────────────────────────────────────────────
-- Tracks each moderator action taken on an owner mismatch flag.
-- This creates a full audit trail of the review workflow.
CREATE TABLE mismatch_review_actions (
  action_id        TEXT PRIMARY KEY,
  flag_id          TEXT NOT NULL REFERENCES owner_mismatch_flags (flag_id) ON DELETE CASCADE,
  moderator_id     TEXT NOT NULL,  -- agent_id of the moderator who acted
  action_type      TEXT NOT NULL CHECK (action_type IN ('reviewed', 'cleared', 'escalated', 'banned')),
  notes            TEXT,
  acted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mismatch_review_actions_flag_id ON mismatch_review_actions (flag_id);
CREATE INDEX idx_mismatch_review_actions_moderator ON mismatch_review_actions (moderator_id);

-- ── Moderation Queue Priority View ────────────────────────────────────────────
-- Used by GET /v1/moderation/owner-mismatches to return ordered unresolved flags.
CREATE VIEW moderation_mismatch_queue AS
SELECT
  f.flag_id,
  f.agent_id,
  a.owner_handle AS current_handle,
  f.previous_handle,
  f.new_handle,
  f.detected_at,
  -- Age in hours for priority sorting
  EXTRACT(EPOCH FROM (NOW() - f.detected_at)) / 3600.0 AS age_hours,
  -- Count review actions already taken
  COUNT(r.action_id) AS review_count,
  -- Latest action type
  MAX(r.action_type) FILTER (WHERE r.acted_at = (
    SELECT MAX(acted_at) FROM mismatch_review_actions WHERE flag_id = f.flag_id
  )) AS latest_action,
  a.status AS agent_status,
  a.trust_tier
FROM owner_mismatch_flags f
JOIN agents a ON a.agent_id = f.agent_id
LEFT JOIN mismatch_review_actions r ON r.flag_id = f.flag_id
WHERE f.resolved_at IS NULL
GROUP BY f.flag_id, f.agent_id, a.owner_handle, f.previous_handle,
         f.new_handle, f.detected_at, a.status, a.trust_tier
ORDER BY f.detected_at ASC;  -- Oldest first

COMMENT ON VIEW moderation_mismatch_queue IS
  'Ordered list of unresolved owner mismatch flags for the moderator dashboard. '
  'Sorted by detected_at ASC so oldest mismatches are reviewed first.';

-- ── Index for fast unresolved lookups ─────────────────────────────────────────
-- (Partial index for WHERE resolved_at IS NULL — already in 002 but ensure exists)
CREATE INDEX IF NOT EXISTS idx_owner_mismatch_flags_unresolved
  ON owner_mismatch_flags (agent_id)
  WHERE resolved_at IS NULL;

COMMIT;
