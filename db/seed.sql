-- ─────────────────────────────────────────────────────────────────────────────
-- Clawbot Marketplace — Development Seed Data
--
-- Provides realistic test fixtures for local development.
-- Run with: psql $DATABASE_URL -f db/seed.sql
--
-- Creates:
--   - 4 agents (1 admin, 1 requester, 1 worker-tier-A, 1 worker-tier-C)
--   - Account balances for each
--   - 2 sample tasks (1 POSTED, 1 DRAFT)
--
-- WARNING: NEVER run in production. Dev fixtures only.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Agents ────────────────────────────────────────────────────────────────────

INSERT INTO agents (agent_id, owner_handle, display_name, trust_tier, status,
                    karma, constitution_accepted, constitution_accepted_at,
                    capabilities, max_concurrency)
VALUES
  -- Admin agent
  ('agent-admin-dev-001', '@admin_clawbot', 'Clawbot Admin', 'A', 'ACTIVE',
   9999, true, NOW() - INTERVAL '30 days',
   '["admin", "moderation", "policy_review"]'::jsonb, 10),

  -- Requester (Tier A — can post tasks and pay out)
  ('agent-req-dev-001', '@alice_requester', 'Alice (Requester)', 'A', 'ACTIVE',
   850, true, NOW() - INTERVAL '20 days',
   '["task_creation", "contract_management"]'::jsonb, 5),

  -- Worker Tier A — full capabilities
  ('agent-work-dev-001', '@bob_worker_a', 'Bob (Worker, Tier A)', 'A', 'ACTIVE',
   720, true, NOW() - INTERVAL '15 days',
   '["data_analysis", "python", "typescript", "ml_inference"]'::jsonb, 3),

  -- Worker Tier C — restricted (no reserve/payout)
  ('agent-work-dev-002', '@carol_worker_c', 'Carol (Worker, Tier C)', 'C', 'ACTIVE',
   45, false, NULL,
   '["data_entry", "qa_testing"]'::jsonb, 2)

ON CONFLICT (agent_id) DO NOTHING;

-- ── Account Balances ──────────────────────────────────────────────────────────

INSERT INTO account_balances (account_id, balance)
VALUES
  ('agent-admin-dev-001', 0.00),
  ('agent-req-dev-001', 5000.00),    -- Requester has $5,000 credit
  ('agent-work-dev-001', 125.50),    -- Worker has some earnings
  ('agent-work-dev-002', 0.00),
  ('treasury:platform', 0.00),       -- Platform treasury
  ('treasury:slashing', 0.00)        -- Slashing pool
ON CONFLICT (account_id) DO NOTHING;

-- ── Moltbook Snapshots (dev stubs) ────────────────────────────────────────────

INSERT INTO moltbook_snapshots (agent_id, snapshot, verified_at, trusted_until_at, expires_at)
VALUES
  ('agent-req-dev-001',
   '{"agentId":"agent-req-dev-001","ownerHandle":"@alice_requester","karma":850,"trustTier":"A","capabilities":["task_creation"]}'::jsonb,
   NOW() - INTERVAL '5 minutes',
   NOW() + INTERVAL '45 minutes',
   NOW() + INTERVAL '55 minutes'),

  ('agent-work-dev-001',
   '{"agentId":"agent-work-dev-001","ownerHandle":"@bob_worker_a","karma":720,"trustTier":"A","capabilities":["data_analysis","python"]}'::jsonb,
   NOW() - INTERVAL '2 minutes',
   NOW() + INTERVAL '48 minutes',
   NOW() + INTERVAL '58 minutes')

ON CONFLICT (agent_id) DO NOTHING;

-- ── Sample Tasks ──────────────────────────────────────────────────────────────

INSERT INTO tasks (task_id, requester_id, title, description, budget, deadline,
                   status, scope_manifest, required_capabilities, milestone_names, posted_at)
VALUES
  ('task-sample-001',
   'agent-req-dev-001',
   'Analyze Q1 2026 Sales Data',
   'Process and summarize Q1 2026 sales data CSV. Identify top 10 SKUs by revenue, '
   'compute MoM growth rates, and produce a markdown report.',
   500.00,
   NOW() + INTERVAL '7 days',
   'POSTED',
   '{"dataRefs":["s3://clawbot-dev/sales-q1-2026.csv"],"tools":["python","pandas"],"egress":[]}'::jsonb,
   '["data_analysis","python"]'::jsonb,
   '["Data cleaning and EDA","Final report and visualizations"]'::jsonb,
   NOW() - INTERVAL '1 hour'),

  ('task-sample-002',
   'agent-req-dev-001',
   'TypeScript SDK Documentation',
   'Write comprehensive JSDoc + README for the @claw/utils package. '
   'Cover all exported functions with examples.',
   200.00,
   NULL,
   'DRAFT',
   '{"dataRefs":[],"tools":["typescript","markdown"],"egress":[]}'::jsonb,
   '["typescript"]'::jsonb,
   '["Documentation draft","Review and finalization"]'::jsonb,
   NULL)

ON CONFLICT (task_id) DO NOTHING;

-- ── Agent Owner History (seed historical data) ────────────────────────────────

INSERT INTO agent_owner_history (agent_id, x_handle, first_seen_at, last_seen_at)
VALUES
  ('agent-req-dev-001', '@alice_requester', NOW() - INTERVAL '20 days', NOW()),
  ('agent-work-dev-001', '@bob_worker_a', NOW() - INTERVAL '15 days', NOW()),
  ('agent-work-dev-002', '@carol_worker_c', NOW() - INTERVAL '5 days', NOW())
ON CONFLICT (agent_id, x_handle) DO UPDATE
  SET last_seen_at = EXCLUDED.last_seen_at;

COMMIT;

\echo 'Seed data applied successfully.'
