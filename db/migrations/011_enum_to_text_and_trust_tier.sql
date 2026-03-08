-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011: Remaining Enum-to-TEXT Conversions
--
-- TASK-HARD-003: PostgreSQL persistence layer — completeness fixes
--
-- Migration 006 converted most enum columns to TEXT for domain model fidelity.
-- Two enum types were missed:
--
-- 1. dispute_ruling enum — the disputes.ruling column still uses the
--    dispute_ruling enum ('pay_worker', 'refund_requester', 'split').
--    The domain model uses z.string() for finalRuling, so this must be TEXT
--    to avoid insert failures if new ruling types are added.
--
-- 2. trust_tier enum — the agents.trust_tier column still uses the
--    trust_tier enum ('A', 'B', 'C'). While current code writes 'C',
--    future changes should not be blocked by enum constraints.
--
-- 3. ledger_entry_type enum — was converted in migration 006 line 79, but
--    the enum type itself still exists. Dropping unused enums for cleanup.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. dispute_ruling: enum → TEXT ─────────────────────────────────────────
ALTER TABLE disputes ALTER COLUMN ruling TYPE TEXT USING ruling::TEXT;

-- ── 2. trust_tier: enum → TEXT ─────────────────────────────────────────────
ALTER TABLE agents ALTER COLUMN trust_tier DROP DEFAULT;
ALTER TABLE agents ALTER COLUMN trust_tier TYPE TEXT USING trust_tier::TEXT;
ALTER TABLE agents ALTER COLUMN trust_tier SET DEFAULT 'C';
