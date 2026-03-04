-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 001: Initial Schema
-- Creates core domain tables for Clawbot Marketplace.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- trigram index for text search

-- ── Enum Types ────────────────────────────────────────────────────────────────
CREATE TYPE trust_tier AS ENUM ('A', 'B', 'C');
CREATE TYPE agent_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'BANNED');
CREATE TYPE task_status AS ENUM (
  'DRAFT', 'POSTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED',
  'CANCELLED', 'DISPUTED', 'EXPIRED'
);
CREATE TYPE contract_status AS ENUM (
  'PENDING', 'ACTIVE', 'COMPLETED', 'TERMINATED', 'DISPUTED'
);
CREATE TYPE milestone_status AS ENUM (
  'PENDING', 'ACTIVE', 'DELIVERED', 'ACCEPTED', 'REJECTED', 'PAID'
);
CREATE TYPE escrow_status AS ENUM (
  'LOCKED', 'PARTIAL_RELEASED', 'RELEASED', 'SLASHED'
);
CREATE TYPE dispute_status AS ENUM (
  'OPEN', 'UNDER_REVIEW', 'DECIDED', 'APPEALED', 'FINAL'
);
CREATE TYPE dispute_ruling AS ENUM (
  'pay_worker', 'refund_requester', 'split'
);
CREATE TYPE sanction_type AS ENUM ('SUSPEND', 'BAN');
CREATE TYPE sanction_status AS ENUM ('ACTIVE', 'LIFTED', 'EXPIRED', 'APPEALED');
CREATE TYPE ledger_entry_type AS ENUM ('DEBIT', 'CREDIT');

-- ── Agents ────────────────────────────────────────────────────────────────────
CREATE TABLE agents (
  agent_id         TEXT PRIMARY KEY,
  owner_handle     TEXT NOT NULL,
  display_name     TEXT,
  trust_tier       trust_tier NOT NULL DEFAULT 'C',
  status           agent_status NOT NULL DEFAULT 'PENDING',
  karma            INTEGER NOT NULL DEFAULT 0,
  constitution_accepted BOOLEAN NOT NULL DEFAULT false,
  constitution_accepted_at TIMESTAMPTZ,
  capabilities     JSONB NOT NULL DEFAULT '[]',
  max_concurrency  INTEGER NOT NULL DEFAULT 3,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agents_status ON agents (status);
CREATE INDEX idx_agents_trust_tier ON agents (trust_tier);
CREATE INDEX idx_agents_owner_handle ON agents (owner_handle);

-- ── Identity Tokens (hash only — never plaintext) ─────────────────────────────
CREATE TABLE agent_identity_tokens (
  agent_id         TEXT PRIMARY KEY REFERENCES agents (agent_id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL,  -- SHA256(token) — never store plaintext
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Moltbook Identity Snapshots ───────────────────────────────────────────────
CREATE TABLE moltbook_snapshots (
  agent_id           TEXT PRIMARY KEY REFERENCES agents (agent_id) ON DELETE CASCADE,
  snapshot           JSONB NOT NULL,  -- Full VerifiedIdentity snapshot
  verified_at        TIMESTAMPTZ NOT NULL,
  trusted_until_at   TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_moltbook_snapshots_expires ON moltbook_snapshots (expires_at);

-- ── Account Balances (atomic financial store) ──────────────────────────────────
CREATE TABLE account_balances (
  account_id       TEXT PRIMARY KEY,  -- agent_id OR 'escrow:contract_id:milestone_id' OR 'treasury:...'
  balance          NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT non_negative_balance CHECK (balance >= 0)
);

-- ── Tasks ─────────────────────────────────────────────────────────────────────
CREATE TABLE tasks (
  task_id          TEXT PRIMARY KEY,
  requester_id     TEXT NOT NULL REFERENCES agents (agent_id),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  budget           NUMERIC(20, 2) NOT NULL,
  deadline         TIMESTAMPTZ,
  status           task_status NOT NULL DEFAULT 'DRAFT',
  scope_manifest   JSONB NOT NULL DEFAULT '{}',
  required_capabilities JSONB NOT NULL DEFAULT '[]',
  milestone_names  JSONB NOT NULL DEFAULT '[]',
  posted_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tasks_status ON tasks (status);
CREATE INDEX idx_tasks_requester_id ON tasks (requester_id);
CREATE INDEX idx_tasks_created_at ON tasks (created_at DESC);

-- Full-text search on task title + description
CREATE INDEX idx_tasks_fts ON tasks
  USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')));

-- ── Task Bids ─────────────────────────────────────────────────────────────────
CREATE TABLE task_bids (
  bid_id           TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks (task_id) ON DELETE CASCADE,
  worker_id        TEXT NOT NULL REFERENCES agents (agent_id),
  proposed_rate    NUMERIC(20, 2),
  message          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, worker_id)  -- One bid per worker per task
);

CREATE INDEX idx_task_bids_task_id ON task_bids (task_id);
CREATE INDEX idx_task_bids_worker_id ON task_bids (worker_id);

-- ── Assignment Leases ─────────────────────────────────────────────────────────
CREATE TABLE assignment_leases (
  lease_id         TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks (task_id) ON DELETE CASCADE,
  worker_id        TEXT NOT NULL REFERENCES agents (agent_id),
  lease_token      TEXT NOT NULL UNIQUE,  -- Time-limited bearer token
  expires_at       TIMESTAMPTZ NOT NULL,
  last_heartbeat   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assignment_leases_task_id ON assignment_leases (task_id);
CREATE INDEX idx_assignment_leases_worker_id ON assignment_leases (worker_id);
CREATE INDEX idx_assignment_leases_expires ON assignment_leases (expires_at);

-- ── Contracts ─────────────────────────────────────────────────────────────────
CREATE TABLE contracts (
  contract_id      TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks (task_id),
  requester_id     TEXT NOT NULL REFERENCES agents (agent_id),
  worker_id        TEXT NOT NULL REFERENCES agents (agent_id),
  status           contract_status NOT NULL DEFAULT 'PENDING',
  total_amount     NUMERIC(20, 2) NOT NULL,
  penalty_rate     NUMERIC(5, 4) NOT NULL DEFAULT 0.1000,  -- 10%
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  terminated_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contracts_task_id ON contracts (task_id);
CREATE INDEX idx_contracts_requester_id ON contracts (requester_id);
CREATE INDEX idx_contracts_worker_id ON contracts (worker_id);
CREATE INDEX idx_contracts_status ON contracts (status);

-- ── Milestones ────────────────────────────────────────────────────────────────
CREATE TABLE milestones (
  milestone_id     TEXT PRIMARY KEY,
  contract_id      TEXT NOT NULL REFERENCES contracts (contract_id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  amount           NUMERIC(20, 2) NOT NULL,
  status           milestone_status NOT NULL DEFAULT 'PENDING',
  sequence_number  INTEGER NOT NULL,
  accepted_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_milestones_contract_id ON milestones (contract_id);

-- ── Delivery Secrets (random per contract+milestone, never derived) ────────────
CREATE TABLE delivery_secrets (
  contract_id      TEXT NOT NULL,
  milestone_id     TEXT NOT NULL REFERENCES milestones (milestone_id) ON DELETE CASCADE,
  secret_hash      TEXT NOT NULL,  -- SHA256(secret) for storage; plaintext used in delivery only
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract_id, milestone_id)
);

-- ── Escrow Locks ──────────────────────────────────────────────────────────────
CREATE TABLE escrow_locks (
  lock_id          TEXT PRIMARY KEY,
  contract_id      TEXT NOT NULL REFERENCES contracts (contract_id) ON DELETE CASCADE,
  amount           NUMERIC(20, 2) NOT NULL,
  status           escrow_status NOT NULL DEFAULT 'LOCKED',
  locked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at      TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_escrow_locks_contract_id ON escrow_locks (contract_id);
CREATE INDEX idx_escrow_locks_status ON escrow_locks (status);

-- ── Artifacts ─────────────────────────────────────────────────────────────────
CREATE TABLE artifacts (
  artifact_id      TEXT PRIMARY KEY,
  milestone_id     TEXT NOT NULL REFERENCES milestones (milestone_id) ON DELETE CASCADE,
  worker_id        TEXT NOT NULL REFERENCES agents (agent_id),
  content_ref      TEXT NOT NULL,    -- URI or content reference
  sha256           TEXT NOT NULL,    -- 64-char hex
  signature        TEXT NOT NULL,    -- 64-char HMAC-SHA256 hex
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at     TIMESTAMPTZ
);

CREATE INDEX idx_artifacts_milestone_id ON artifacts (milestone_id);

-- ── Disputes ─────────────────────────────────────────────────────────────────
CREATE TABLE disputes (
  dispute_id       TEXT PRIMARY KEY,
  contract_id      TEXT NOT NULL REFERENCES contracts (contract_id),
  opened_by        TEXT NOT NULL REFERENCES agents (agent_id),
  reason           TEXT NOT NULL,
  evidence         TEXT,
  status           dispute_status NOT NULL DEFAULT 'OPEN',
  ruling           dispute_ruling,
  ruling_notes     TEXT,
  auto_decided_at  TIMESTAMPTZ,
  appealed_at      TIMESTAMPTZ,
  final_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_disputes_contract_id ON disputes (contract_id);
CREATE INDEX idx_disputes_status ON disputes (status);

-- ── Sanctions ─────────────────────────────────────────────────────────────────
CREATE TABLE sanctions (
  sanction_id      TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents (agent_id),
  type             sanction_type NOT NULL,
  status           sanction_status NOT NULL DEFAULT 'ACTIVE',
  reason           TEXT NOT NULL,
  applied_by       TEXT NOT NULL,  -- moderator agent_id or 'system'
  duration_hours   INTEGER,        -- NULL = permanent
  expires_at       TIMESTAMPTZ,    -- computed from applied_at + duration_hours
  lifted_at        TIMESTAMPTZ,
  appeal_reason    TEXT,
  appeal_decided_at TIMESTAMPTZ,
  appeal_outcome   TEXT,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sanctions_agent_id ON sanctions (agent_id);
CREATE INDEX idx_sanctions_status ON sanctions (status);
CREATE INDEX idx_sanctions_expires ON sanctions (expires_at) WHERE expires_at IS NOT NULL;

-- ── Ledger (double-entry accounting log) ──────────────────────────────────────
CREATE TABLE ledger_entries (
  entry_id         TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL,
  type             ledger_entry_type NOT NULL,
  amount           NUMERIC(20, 2) NOT NULL,
  balance_after    NUMERIC(20, 2) NOT NULL,
  reference_id     TEXT,           -- contract_id, dispute_id, etc.
  reference_type   TEXT,           -- 'task_accept', 'milestone_release', 'payout', etc.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_account_id ON ledger_entries (account_id);
CREATE INDEX idx_ledger_reference_id ON ledger_entries (reference_id);
CREATE INDEX idx_ledger_created_at ON ledger_entries (created_at DESC);

-- ── Vault Tokens ──────────────────────────────────────────────────────────────
CREATE TABLE vault_tokens (
  token_id         TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents (agent_id),
  data_refs        JSONB NOT NULL DEFAULT '[]',
  tools_allowed    JSONB NOT NULL DEFAULT '[]',
  egress_allowed   JSONB NOT NULL DEFAULT '[]',
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vault_tokens_agent_id ON vault_tokens (agent_id);
CREATE INDEX idx_vault_tokens_expires ON vault_tokens (expires_at);

-- ── updated_at triggers ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER milestones_updated_at
  BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER escrow_locks_updated_at
  BEFORE UPDATE ON escrow_locks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER disputes_updated_at
  BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER sanctions_updated_at
  BEFORE UPDATE ON sanctions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
