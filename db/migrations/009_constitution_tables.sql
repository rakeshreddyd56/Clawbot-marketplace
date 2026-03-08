-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009: Constitution Version & Acceptance Tables
--
-- TASK-HARD-003 / TASK-ENFORCE-001: Persist constitution versioning and
-- per-agent acceptance records across restarts.
--
-- Tables:
--   1. constitution_versions — version history with SHA256 hashes
--   2. constitution_acceptances — per-agent acceptance records
--   3. constitution_config — key-value config (stores currentConstitutionVersion)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Constitution version history ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS constitution_versions (
  version               TEXT PRIMARY KEY,
  published_at          TIMESTAMPTZ NOT NULL,
  sha256_hash           TEXT NOT NULL,
  changelog             TEXT NOT NULL DEFAULT '',
  re_acceptance_deadline_days INTEGER NOT NULL DEFAULT 7,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the default v1 constitution version if not already present
INSERT INTO constitution_versions (version, published_at, sha256_hash, changelog, re_acceptance_deadline_days)
VALUES ('v1', NOW(), 'genesis', 'Initial constitution version', 7)
ON CONFLICT (version) DO NOTHING;

-- ── 2. Per-agent constitution acceptances ───────────────────────────────────
CREATE TABLE IF NOT EXISTS constitution_acceptances (
  agent_id              TEXT PRIMARY KEY,
  constitution_version  TEXT NOT NULL,
  constitution_hash     TEXT NOT NULL,
  accepted_at           TIMESTAMPTZ NOT NULL,
  ip_hash               TEXT,
  audit_event_id        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_constitution_acceptances_version
  ON constitution_acceptances (constitution_version);

-- ── 3. Constitution config (key-value for scalar settings) ──────────────────
CREATE TABLE IF NOT EXISTS constitution_config (
  key                   TEXT PRIMARY KEY,
  value                 TEXT NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the current constitution version
INSERT INTO constitution_config (key, value)
VALUES ('current_version', 'v1')
ON CONFLICT (key) DO NOTHING;
