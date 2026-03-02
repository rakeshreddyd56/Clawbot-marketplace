# Task Tracker

## Status Legend
- `backlog` — Not started, not assigned
- `assigned` — Assigned to an agent, in progress
- `review` — Implementation done, needs review
- `testing` — Under test by tester agent
- `failed` — Tests failed, needs rework
- `tested` — All tests pass, ready to merge
- `done` — Merged to main

## Active Sprint

### Hardening Tasks (Alpha → Beta)

### TASK-HARD-001: Replace fake Moltbook adapter with real OAuth client
- **Status:** backlog
- **Priority:** P0
- **Assigned to:** —
- **Depends on:** —
- **Description:** Replace FakeMoltbookVerifier with real OAuth/SAML integration for production identity verification
- **Files to modify:**
  - `apps/api/src/adapters/moltbook.ts` (modify)
  - `apps/api/src/services/moltbook-identity-service.ts` (modify)
- **Acceptance Criteria:**
  - [ ] Real Moltbook API integration
  - [ ] Token validation with Moltbook server
  - [ ] Trust tier computed from real karma/posts/comments
  - [ ] Fallback to fake adapter when MOLTBOOK_API_URL not set
  - [ ] Integration tests with mock Moltbook server
  - [ ] No lint/type errors

### TASK-HARD-002: Replace fake Stripe adapter with real Stripe Connect
- **Status:** backlog
- **Priority:** P0
- **Assigned to:** —
- **Depends on:** —
- **Description:** Wire up real Stripe Connect for topups, payouts, and webhook verification
- **Files to modify:**
  - `apps/api/src/adapters/stripe.ts` (modify)
  - `apps/api/src/services/payment-webhook-service.ts` (modify)
  - `apps/api/src/app.ts` (webhook signature verification)
- **Acceptance Criteria:**
  - [ ] Stripe Connect integration for topups and payouts
  - [ ] Webhook signature verification (stripe.webhooks.constructEvent)
  - [ ] Idempotency keys on all Stripe operations
  - [ ] Fallback to fake adapter when STRIPE_API_KEY not set
  - [ ] Tests with Stripe test mode
  - [ ] No lint/type errors

### TASK-HARD-003: Add PostgreSQL persistence layer
- **Status:** backlog
- **Priority:** P0
- **Assigned to:** —
- **Depends on:** —
- **Description:** Replace in-memory Map store with PostgreSQL using migrations
- **Files to create/modify:**
  - `apps/api/src/core/store.ts` (rewrite to use Postgres)
  - `db/migrations/` (create)
  - `docker-compose.yml` (create)
- **Acceptance Criteria:**
  - [ ] All Map collections migrated to Postgres tables
  - [ ] Migration system set up (node-pg-migrate or similar)
  - [ ] Connection pooling configured
  - [ ] All existing tests pass against Postgres
  - [ ] docker-compose.yml with PostgreSQL 15
  - [ ] Seed script for development data
  - [ ] No lint/type errors

### TASK-HARD-004: Add Temporal workflow worker runtime
- **Status:** backlog
- **Priority:** P1
- **Assigned to:** —
- **Depends on:** TASK-HARD-003
- **Description:** Wire Temporal adapter with actual workflow worker for task lifecycle, contract execution, and dispute resolution
- **Files to modify:**
  - `apps/api/src/adapters/temporal.ts` (modify)
  - `packages/workflows/src/index.ts` (ensure Temporal compatibility)
- **Acceptance Criteria:**
  - [ ] Temporal client connection
  - [ ] Workflow workers registered for task queue
  - [ ] State machine functions called from workflow activities
  - [ ] Replay-safe deterministic execution
  - [ ] Tests with Temporal test server

### TASK-HARD-005: Enforce signed Stripe webhook verification + idempotency
- **Status:** backlog
- **Priority:** P1
- **Assigned to:** —
- **Depends on:** TASK-HARD-002
- **Description:** Add proper webhook signature verification and idempotency to all payment operations
- **Files to modify:**
  - `apps/api/src/app.ts` (webhook route)
  - `apps/api/src/services/payment-webhook-service.ts`
- **Acceptance Criteria:**
  - [ ] stripe.webhooks.constructEvent for all webhook payloads
  - [ ] Idempotency keys on topup and payout operations
  - [ ] Replay protection on webhook events
  - [ ] Tests for duplicate event handling

### TASK-HARD-006: Full test coverage for escrow operations
- **Status:** backlog
- **Priority:** P0
- **Assigned to:** —
- **Depends on:** —
- **Description:** Comprehensive tests for escrow lock, release, slash, and balance operations
- **Files to create:**
  - `apps/api/__tests__/escrow.test.ts` (create)
  - `apps/api/__tests__/ledger.test.ts` (create)
- **Acceptance Criteria:**
  - [ ] Test escrow lock on contract creation
  - [ ] Test escrow release on milestone acceptance
  - [ ] Test slashing on dispute resolution
  - [ ] Test double-spend prevention
  - [ ] Test concurrent topup + payout
  - [ ] Balance never goes negative

## Feature Tasks

### TASK-FEAT-001: [Next Feature]
- **Status:** backlog
- **Priority:** —
- **Assigned to:** —
- **Depends on:** —
- **Description:** [To be filled by architect]
- **Acceptance Criteria:**
  - [ ] [To be filled]

## Completed Tasks
[Moved here when status reaches "done"]
