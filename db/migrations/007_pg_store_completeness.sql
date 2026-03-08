-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: PgStore Completeness
--
-- Fixes remaining schema gaps for full domain model fidelity:
--
-- 1. artifacts: Add contract_id column (ArtifactRecord.contractId)
-- 2. tasks: Add pricing_mode column (Task.pricingMode)
-- 3. ledger_entries: Add reason column (LedgerEntry.reason)
-- 4. account_balances: Allow negative balances for treasury accounts
--    (treasury:inbound tracks external money inflow as negative DEBIT)
-- 5. disputes: Add appeal_deadline_at and auto_decision columns
-- 6. artifacts: Add validation_status column (ArtifactRecord.validationStatus)
-- 7. schema_migrations: Tracking table for the migration runner
--
-- TASK-HARD-003: PostgreSQL persistence layer — completeness fixes
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. artifacts.contract_id ──────────────────────────────────────────────────
-- ArtifactRecord now carries contractId (added in BUG-CRIT-NEW-002 fix)
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS contract_id TEXT;
CREATE INDEX IF NOT EXISTS idx_artifacts_contract_id ON artifacts (contract_id);

-- ── 2. tasks.pricing_mode ─────────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'fixed';

-- ── 3. ledger_entries.reason ──────────────────────────────────────────────────
-- LedgerEntry has a `reason` field (e.g., 'escrow.lock', 'wallet.topup') that
-- is separate from `reference_type`. Previously only reference_type was stored.
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';

-- ── 4. account_balances: allow negative for treasury accounts ────────────────
-- Treasury contra-accounts (treasury:inbound, treasury:outbound, treasury:slashing)
-- must go negative to track balanced double-entry accounting.
-- Replace the non_negative_balance constraint with one that only enforces >= 0
-- on non-treasury accounts.
ALTER TABLE account_balances DROP CONSTRAINT IF EXISTS non_negative_balance;
ALTER TABLE account_balances ADD CONSTRAINT non_negative_balance
  CHECK (balance >= 0 OR account_id LIKE 'treasury:%' OR account_id LIKE 'escrow:%');

-- ── 5. disputes: appeal_deadline_at + auto_decision ──────────────────────────
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS appeal_deadline_at TIMESTAMPTZ;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS auto_decision TEXT;

-- ── 6. artifacts.validation_status ────────────────────────────────────────────
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'VALID';

-- ── 7. schema_migrations table for migration runner ──────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum    TEXT NOT NULL
);

-- ── 8. ledger_entries.asset_type ──────────────────────────────────────────────
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS asset_type TEXT NOT NULL DEFAULT 'credits';
