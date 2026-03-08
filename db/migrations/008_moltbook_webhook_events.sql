-- Migration 008: Moltbook webhook event deduplication
-- TASK-HARD-003 / TASK-HARD-014: Track processed Moltbook webhook event IDs
-- for replay protection (same pattern as Stripe processed_webhook_events).

CREATE TABLE IF NOT EXISTS processed_moltbook_webhook_events (
  event_id    TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moltbook_webhook_events_processed
  ON processed_moltbook_webhook_events (processed_at);
