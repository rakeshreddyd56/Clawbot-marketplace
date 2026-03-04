-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003: Audit Ledger (Hash-Chained Immutable Events)
--
-- Persists the hash-chained audit log across restarts. Without this,
-- the audit chain is lost on server restart, destroying tamper-evidence.
--
-- Chain integrity: each event's hash is SHA256(event_type + entity_id +
--   payload_json + timestamp + previous_hash). This creates a Merkle-like
--   linked list where any tampering invalidates all subsequent hashes.
--
-- IMPORTANT:
--   - Rows MUST NOT be updated or deleted (immutable by design)
--   - The sequence_number must be monotonically increasing (enforced by trigger)
--   - Use GET /v1/events/verify to re-validate the chain at any time
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Audit Events ──────────────────────────────────────────────────────────────
CREATE TABLE audit_events (
  event_id         TEXT PRIMARY KEY,
  sequence_number  BIGSERIAL UNIQUE NOT NULL,  -- Monotonic global sequence
  event_type       TEXT NOT NULL,              -- e.g. 'task.created', 'escrow.locked'
  entity_id        TEXT NOT NULL,              -- Primary entity (task_id, contract_id, etc.)
  entity_type      TEXT NOT NULL,              -- 'task' | 'contract' | 'agent' | etc.
  actor_id         TEXT,                        -- Who triggered the event (NULL = system)
  payload          JSONB NOT NULL DEFAULT '{}',
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_hash    TEXT NOT NULL,              -- Hash of previous event (or 'GENESIS' for first)
  hash             TEXT NOT NULL UNIQUE        -- SHA256 of this event's fields + previous_hash
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- Covering index for chain verification (sequential scan in order)
CREATE INDEX idx_audit_events_sequence ON audit_events (sequence_number ASC);

-- Entity-scoped lookups (e.g., all events for a contract)
CREATE INDEX idx_audit_events_entity ON audit_events (entity_type, entity_id);

-- Actor-scoped lookups
CREATE INDEX idx_audit_events_actor_id ON audit_events (actor_id) WHERE actor_id IS NOT NULL;

-- Time-range queries
CREATE INDEX idx_audit_events_timestamp ON audit_events (timestamp DESC);

-- Event type filtering
CREATE INDEX idx_audit_events_event_type ON audit_events (event_type);

-- ── Immutability: prevent UPDATE and DELETE ───────────────────────────────────
CREATE OR REPLACE FUNCTION audit_events_no_mutate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is immutable — UPDATE/DELETE are not permitted. '
    'The audit chain must never be modified.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_prevent_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate();

CREATE TRIGGER audit_events_prevent_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate();

-- ── Chain verification view ───────────────────────────────────────────────────
-- Used by GET /v1/events/verify to walk the chain without loading all payloads.
CREATE VIEW audit_chain_view AS
SELECT
  event_id,
  sequence_number,
  event_type,
  entity_id,
  entity_type,
  actor_id,
  timestamp,
  previous_hash,
  hash,
  -- Compute expected hash inline for cross-check (re-hashing is done in app layer)
  lag(hash, 1, 'GENESIS') OVER (ORDER BY sequence_number) AS expected_previous_hash,
  -- Flag mismatches (previous_hash should equal the previous row's hash)
  CASE
    WHEN lag(hash, 1, 'GENESIS') OVER (ORDER BY sequence_number) = previous_hash
    THEN true ELSE false
  END AS chain_valid
FROM audit_events
ORDER BY sequence_number;

COMMENT ON TABLE audit_events IS
  'Immutable hash-chained audit log. Each event references the hash of its predecessor. '
  'Any modification to a past event is detectable by re-walking the chain.';

COMMENT ON COLUMN audit_events.previous_hash IS
  'SHA256 hash of the immediately preceding event, or the literal string GENESIS for event #1.';

COMMENT ON COLUMN audit_events.hash IS
  'SHA256(event_type || entity_id || payload_json || timestamp_iso || previous_hash)';

COMMENT ON TRIGGER audit_events_prevent_update ON audit_events IS
  'Enforces immutability: UPDATE on audit_events always raises an error.';

COMMENT ON TRIGGER audit_events_prevent_delete ON audit_events IS
  'Enforces immutability: DELETE on audit_events always raises an error.';

COMMIT;
