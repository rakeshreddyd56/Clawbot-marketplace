-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: PgStore Schema Fixes
--
-- Fixes issues found in the initial PgStore implementation:
--
-- 1. Task status: Change from enum to TEXT to support all domain statuses
--    (RESERVED, DELIVERED, ACCEPTED, RESOLVED, CLOSED) without enum limitations.
--
-- 2. Lease status: Add status column to assignment_leases table so lease
--    state transitions (ACTIVE → CLOSED) are persisted across restarts.
--
-- 3. Delivery secrets: Rename secret_hash to secret_value and store the
--    actual secret (not its hash). The secret is needed at runtime for HMAC
--    signature verification on artifact delivery. Without the actual secret,
--    delivery verification breaks after restart.
--
-- 4. Contract status: Change from enum to TEXT for domain model fidelity.
--
-- TASK-HARD-003: PostgreSQL persistence layer — bug fixes
-- ─────────────────────────────────────────────────────────────────────────────

-- NOTE: Each ALTER TYPE ... ADD VALUE must be outside a transaction block
-- in PostgreSQL < 12. For PG 15 (our target), we can group them but
-- switching to TEXT is simpler and more future-proof.

-- ── 1. Task status: enum → TEXT ──────────────────────────────────────────────
-- Drop the old enum constraint and switch to TEXT for full domain model fidelity.
ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;
ALTER TABLE tasks ALTER COLUMN status TYPE TEXT USING status::TEXT;
ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'DRAFT';

-- Drop the old enum type (only if no other columns reference it)
-- We keep it in case other code references it, but tasks now uses TEXT.

-- ── 2. Lease status column ───────────────────────────────────────────────────
ALTER TABLE assignment_leases ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_assignment_leases_status ON assignment_leases (status);

-- ── 3. Delivery secrets: store actual secret, not hash ───────────────────────
-- The secret is needed for HMAC verification at runtime. Storing only the hash
-- means delivery verification breaks after server restart.
ALTER TABLE delivery_secrets RENAME COLUMN secret_hash TO secret_value;
COMMENT ON COLUMN delivery_secrets.secret_value IS
  'The actual delivery secret (hex-encoded random bytes). Needed at runtime for '
  'HMAC signature verification on artifact delivery. Must not be exposed via API.';

-- ── 4. Contract status: enum → TEXT ──────────────────────────────────────────
ALTER TABLE contracts ALTER COLUMN status DROP DEFAULT;
ALTER TABLE contracts ALTER COLUMN status TYPE TEXT USING status::TEXT;
ALTER TABLE contracts ALTER COLUMN status SET DEFAULT 'PENDING';

-- ── 5. Milestone status: enum → TEXT ─────────────────────────────────────────
ALTER TABLE milestones ALTER COLUMN status DROP DEFAULT;
ALTER TABLE milestones ALTER COLUMN status TYPE TEXT USING status::TEXT;
ALTER TABLE milestones ALTER COLUMN status SET DEFAULT 'PENDING';

-- ── 6. Dispute status: enum → TEXT ───────────────────────────────────────────
ALTER TABLE disputes ALTER COLUMN status DROP DEFAULT;
ALTER TABLE disputes ALTER COLUMN status TYPE TEXT USING status::TEXT;
ALTER TABLE disputes ALTER COLUMN status SET DEFAULT 'OPEN';

-- ── 7. Escrow status: enum → TEXT ────────────────────────────────────────────
ALTER TABLE escrow_locks ALTER COLUMN status DROP DEFAULT;
ALTER TABLE escrow_locks ALTER COLUMN status TYPE TEXT USING status::TEXT;
ALTER TABLE escrow_locks ALTER COLUMN status SET DEFAULT 'LOCKED';

-- ── 8. Agent status: enum → TEXT ─────────────────────────────────────────────
ALTER TABLE agents ALTER COLUMN status DROP DEFAULT;
ALTER TABLE agents ALTER COLUMN status TYPE TEXT USING status::TEXT;
ALTER TABLE agents ALTER COLUMN status SET DEFAULT 'PENDING';

-- ── 9. Sanction status/type: enum → TEXT ─────────────────────────────────────
ALTER TABLE sanctions ALTER COLUMN type TYPE TEXT USING type::TEXT;
ALTER TABLE sanctions ALTER COLUMN status DROP DEFAULT;
ALTER TABLE sanctions ALTER COLUMN status TYPE TEXT USING status::TEXT;
ALTER TABLE sanctions ALTER COLUMN status SET DEFAULT 'ACTIVE';

-- ── 10. Ledger entry type: enum → TEXT ───────────────────────────────────────
ALTER TABLE ledger_entries ALTER COLUMN type TYPE TEXT USING type::TEXT;
