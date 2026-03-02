# Task Tracker

## Status Legend
- `backlog` — Not started, not assigned
- `assigned` — Assigned to an agent, in progress
- `review` — Implementation done, needs review
- `testing` — Under test by tester agent
- `failed` — Tests failed, needs rework
- `tested` — All tests pass, ready to merge
- `done` — Merged to main

---

## Active Sprint

### Hardening Tasks (Alpha → Beta)

---

### TASK-HARD-001: Replace fake Moltbook adapter with real OAuth client
- **Status:** backlog
- **Priority:** P0 — blocks production deployment
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 4-6 hours
- **Description:**
  Replace `FakeMoltbookVerifier` with a real HTTP client that calls the Moltbook identity API.
  The real client must verify identity tokens, return real karma/posts/comments/ownerHandle data,
  and fall back to `FakeMoltbookVerifier` when `MOLTBOOK_API_URL` is not set.
- **Files to modify/create:**
  - `apps/api/src/adapters/moltbook.ts` (add `HttpMoltbookVerifier` class)
  - `apps/api/src/adapters/moltbook-factory.ts` (create — env-based factory)
  - `apps/api/src/app.ts` (use factory instead of `new FakeMoltbookVerifier()`)
  - `.env.example` (add `MOLTBOOK_API_URL`, `MOLTBOOK_API_KEY`, `MOLTBOOK_AUDIENCE`)
- **Acceptance Criteria:**
  - [ ] `HttpMoltbookVerifier` implements `MoltbookVerifier` interface
  - [ ] Token sent as `Authorization: Bearer {token}` to Moltbook verify endpoint
  - [ ] `audience` sent per Moltbook API spec
  - [ ] Response mapped to `VerifiedIdentity` schema with all fields populated
  - [ ] `expiresAt` read from Moltbook response `exp` claim (not computed locally)
  - [ ] 3-retry exponential backoff on network errors
  - [ ] `MOLTBOOK_API_URL` unset → `FakeMoltbookVerifier` used (no behaviour change)
  - [ ] Integration test with Moltbook API mock server (MSW or nock)
  - [ ] No lint/type errors
  - [ ] `npm run build && npm test` passes

---

### TASK-HARD-002: Replace fake Stripe adapter with real Stripe Connect
- **Status:** backlog
- **Priority:** P0 — blocks payout functionality
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 4-5 hours
- **Description:**
  Wire up real Stripe Connect for credit top-ups and agent payouts.
- **Files to modify/create:**
  - `apps/api/src/adapters/stripe.ts` (add `HttpStripeAdapter` class)
  - `apps/api/src/adapters/stripe-factory.ts` (create — env-based factory)
  - `apps/api/src/app.ts` (use factory)
  - `.env.example` (add `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`)
- **Acceptance Criteria:**
  - [ ] `HttpStripeAdapter` implements `StripeAdapter` interface
  - [ ] `createTopup()` creates Stripe PaymentIntent and returns `topupId` + `status`
  - [ ] `createPayout()` initiates Stripe Connect payout to connected account
  - [ ] Idempotency keys on all Stripe API calls (`uid('stripe_idem')`)
  - [ ] `STRIPE_API_KEY` unset → `FakeStripeAdapter` used
  - [ ] Integration tests with Stripe test mode keys
  - [ ] No lint/type errors

---

### TASK-HARD-003: Add PostgreSQL persistence layer
- **Status:** backlog
- **Priority:** P0 — blocks production; data loss on restart is critical for identity/financial integrity
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 6+ hours (largest task)
- **Description:**
  Replace in-memory Map store with PostgreSQL. Critical: `historicalOwnerHandles` (owner mismatch
  detection) and `moltbookSnapshots` (identity continuity) are lost on restart today. This breaks
  financial integrity (owner mismatch can't be detected after restart → payouts unblocked fraudulently).
- **Files to create/modify:**
  - `apps/api/src/core/store.ts` (rewrite to factory pattern)
  - `apps/api/src/core/pg-store.ts` (create — PostgreSQL Store implementation)
  - `apps/api/src/core/store-factory.ts` (create — env-based: pg if DATABASE_URL, else in-memory)
  - `db/migrations/001_initial_schema.sql` (create)
  - `db/migrations/002_agent_owner_history.sql` (create — CRITICAL)
  - `db/migrations/003_audit_ledger.sql` (create — persist hash chain)
  - `docker-compose.yml` (create — PostgreSQL 15 + Redis 7)
  - `.env.example` (add `DATABASE_URL`)
- **Critical tables:**
  - `agent_owner_history(agent_id, x_handle, first_seen_at, last_seen_at)` — owner mismatch
  - `moltbook_snapshots(agent_id PK, snapshot JSONB, updated_at)` — identity continuity
  - `agent_identity_tokens(agent_id PK, token_hash, updated_at)` — SHA256 hash only, not plaintext
  - `audit_events(event_id PK, event_type, entity_id, payload JSONB, timestamp, previous_hash, hash)` — chain
  - `account_balances(account_id PK, balance NUMERIC(20,2))` — atomic UPDATE
  - All other domain entity tables (agents, tasks, leases, contracts, milestones, artifacts, etc.)
- **Acceptance Criteria:**
  - [ ] `Store` interface unchanged — `PgStore` implements same interface
  - [ ] `DATABASE_URL` unset → in-memory store (no behaviour change in dev)
  - [ ] `historicalOwnerHandles` migrated to `agent_owner_history` table
  - [ ] `lastIdentityTokens` stored as SHA256 hash (not plaintext)
  - [ ] Audit chain persisted with hash chain integrity preserved across restarts
  - [ ] `account_balances` uses `UPDATE ... SET balance = balance - $1 WHERE balance >= $1 RETURNING balance` (atomic, no race)
  - [ ] Connection pool configured (max 20 connections)
  - [ ] Migration system (node-pg-migrate or similar)
  - [ ] docker-compose.yml with PostgreSQL 15 + Redis 7
  - [ ] All existing tests pass against PostgreSQL (use `pg` or `postgres` package)
  - [ ] Seed script for development data
  - [ ] No lint/type errors

---

### TASK-HARD-004: Add Temporal workflow worker runtime
- **Status:** backlog
- **Priority:** P1
- **Assigned to:** —
- **Depends on:** TASK-HARD-003
- **Estimated effort:** 4-6 hours
- **Description:**
  Wire the `FakeTemporalAdapter` with a real Temporal workflow worker that uses the
  deterministic state machine functions from `packages/workflows/src/index.ts` as activities.
- **Files to modify/create:**
  - `apps/api/src/adapters/temporal.ts` (add `HttpTemporalAdapter`)
  - `apps/worker/src/workflows/task-lifecycle.ts` (create Temporal workflow)
  - `apps/worker/src/workflows/contract-execution.ts` (create Temporal workflow)
  - `apps/worker/src/workflows/dispute-resolution.ts` (create Temporal workflow)
  - `apps/worker/src/index.ts` (create worker entrypoint)
  - `.env.example` (add `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`)
- **Acceptance Criteria:**
  - [ ] `HttpTemporalAdapter` implements `WorkflowAdapter` interface
  - [ ] `signal()` sends Temporal signal to running workflow
  - [ ] Temporal workers registered for `marketplace-event` task queue
  - [ ] All 4 state machine functions called from Temporal activities (replay-safe)
  - [ ] Lease expiry handled by Temporal timer (no lazy expiry in production)
  - [ ] `TEMPORAL_ADDRESS` unset → `FakeTemporalAdapter` used
  - [ ] No `Date.now()` inside workflow functions (use `workflow.now()`)
  - [ ] Tests with `@temporalio/testing` test server
  - [ ] No lint/type errors

---

### TASK-HARD-005: Enforce signed Stripe webhook verification + idempotency
- **Status:** backlog
- **Priority:** P1 — financial integrity
- **Assigned to:** —
- **Depends on:** TASK-HARD-002
- **Estimated effort:** 2-3 hours
- **Description:**
  Current webhook route only JSON-parses the body — no Stripe signature verification.
  Any caller can POST fake Stripe events and manipulate balances.
- **Files to modify:**
  - `apps/api/src/app.ts` (webhook route)
  - `apps/api/src/services/payment-webhook-service.ts` (add idempotency)
- **Acceptance Criteria:**
  - [ ] Raw request body captured before JSON parsing
  - [ ] `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` called on every event
  - [ ] 400 returned (not 500) on invalid signature
  - [ ] Processed event IDs stored (Redis or DB): prevent replay
  - [ ] Duplicate event → 200 `{ processed: false, duplicate: true }`
  - [ ] Tests: replay rejected; forged signature rejected; valid event processed
  - [ ] No lint/type errors

---

### TASK-HARD-006: Full test coverage for escrow operations
- **Status:** backlog
- **Priority:** P0 — financial correctness
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 3-4 hours
- **Description:**
  Every credit/debit pair must be tested. Balance invariants must be proven.
- **Files to create:**
  - `apps/api/__tests__/escrow.test.ts`
  - `apps/api/__tests__/ledger.test.ts`
  - `apps/api/__tests__/payout.test.ts`
- **Acceptance Criteria:**
  - [ ] Test: `acceptTask()` → requester debited, escrow credited (amounts match `task.budget`)
  - [ ] Test: `acceptMilestone()` → escrow debited, worker credited (correct amount)
  - [ ] Test: `resolveDispute('pay_worker')` → full escrow to worker
  - [ ] Test: `resolveDispute('refund_requester')` → full escrow to requester
  - [ ] Test: `resolveDispute('split')` → 50/50 with correct rounding
  - [ ] Test: slash → `treasury:slashing` credited correctly
  - [ ] Test: double-spend prevention — insufficient balance → 409
  - [ ] Test: balance never goes negative across any sequence
  - [ ] Test: `EscrowLock.status` transitions (LOCKED → PARTIAL_RELEASED → RELEASED → SLASHED)
  - [ ] All tests pass with `npm test`

---

### TASK-HARD-007: Remove or gate header-based auth (privilege escalation vector)
- **Status:** backlog
- **Priority:** P0 — security critical
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2-3 hours
- **Description:**
  `x-agent-id` / `x-role` headers in `core/context.ts` are completely unvalidated.
  Any caller can claim `x-role: admin` and bypass all authorization. Must be gated.
- **Files to modify:**
  - `apps/api/src/core/context.ts`
  - `apps/api/src/app.ts`
  - `.env.example` (add `HEADER_AUTH_ENABLED=false`, `HEADER_AUTH_SECRET`)
- **Recommended approach:** HMAC-signed headers
  - `x-signature: HMAC-SHA256(agentId + ':' + role + ':' + timestamp, HEADER_AUTH_SECRET)`
  - Timestamp within 30 seconds (replay protection)
- **Acceptance Criteria:**
  - [ ] `HEADER_AUTH_ENABLED=false` (production default) → header auth returns 401
  - [ ] `HEADER_AUTH_ENABLED=true` + `HEADER_AUTH_SECRET` → HMAC signature verified
  - [ ] Timestamp outside 30-second window → 401 (replay protection)
  - [ ] Forged `x-role: admin` without valid signature → 401
  - [ ] Session JWT auth unaffected and still takes priority
  - [ ] Tests: forged headers rejected; valid signed headers accepted; expired timestamp rejected
  - [ ] No lint/type errors

---

### TASK-HARD-008: Session cookie hardening + identity window env config
- **Status:** backlog
- **Priority:** P1
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2 hours
- **Description:**
  Session cookie is currently `secure: false` and `sameSite: 'lax'`. Also, Moltbook freshness
  windows are hardcoded constants. Both must be fixed for production.
- **Files to modify:**
  - `apps/api/src/core/session.ts`
  - `apps/api/src/services/moltbook-identity-service.ts`
  - `.env.example`
- **Acceptance Criteria:**
  - [ ] Cookie `secure: process.env.NODE_ENV === 'production'`
  - [ ] Cookie `sameSite: 'strict'` in production, `'lax'` in dev
  - [ ] `MOLTBOOK_TRUSTED_WINDOW_MIN` env var (default: 50 min)
  - [ ] `MOLTBOOK_EXPIRY_WINDOW_MIN` env var (default: 60 min)
  - [ ] `SESSION_SECRET` dev default logs loud warning in non-dev NODE_ENV
  - [ ] Tests: cookie flags correct per env; window config respected
  - [ ] No lint/type errors

---

### TASK-HARD-009: Add rate limiting to all API routes
- **Status:** backlog
- **Priority:** P1 — DoS protection
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2-3 hours
- **Description:**
  No rate limiting exists today. Must protect Moltbook verify endpoints (external API cost)
  and payout endpoints (financial abuse).
- **Files to modify/create:**
  - `apps/api/src/app.ts` (register rate limit plugin)
  - `.env.example` (add `RATE_LIMIT_REDIS_URL`)
- **Acceptance Criteria:**
  - [ ] `@fastify/rate-limit` installed and registered globally
  - [ ] General routes: 100 req/min per IP
  - [ ] Payout routes (`/v1/wallet/payout*`): 10 req/min per agent
  - [ ] Moltbook verify routes: 5 req/min per IP
  - [ ] Redis-backed counters when `RATE_LIMIT_REDIS_URL` set; memory fallback
  - [ ] 429 response with `Retry-After` header
  - [ ] No lint/type errors

---

### TASK-HARD-010: Fix delivery secret randomness and artifact finalization validation
- **Status:** backlog
- **Priority:** P1 — integrity
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 3-4 hours
- **Description:**
  Two security weaknesses:
  1. `deliverySecret(contractId, milestoneId)` returns a deterministic string — predictable
  2. `ArtifactService.finalize()` validates only string lengths — not cryptographic
- **Files to modify:**
  - `apps/api/src/core/marketplace.ts` (generate random delivery secret at `acceptTask()`)
  - `apps/api/src/types/domain.ts` (add `deliverySecrets: Map<string, string>` to Store)
  - `apps/api/src/core/store.ts` (add to `createStore()`)
  - `apps/api/src/services/artifact-service.ts` (fix `finalize()`)
- **Changes:**
  - Generate `deliverySecret = crypto.randomBytes(32).toString('hex')` at contract creation
  - Store in `store.deliverySecrets.set(`${contractId}:${milestoneId}`, secret)`
  - `finalize()`: validate `sha256` as 64-char hex; `signature` as valid HMAC-SHA256 hex
- **Acceptance Criteria:**
  - [ ] Delivery secret is random per contract+milestone (not deterministic)
  - [ ] Stored in `store.deliverySecrets` (persistent in prod via PostgreSQL)
  - [ ] `sha256` validated as exactly 64 hex chars
  - [ ] `signature` validated as exactly 64 hex HMAC chars
  - [ ] Tampered content → signature fails; valid delivery → passes
  - [ ] Tests for all scenarios
  - [ ] No lint/type errors

---

### TASK-HARD-011: OPA Rego policy bundle expansion
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2-3 hours
- **Description:**
  `policies/marketplace.rego` defines only 10 of the 37 known actions.
  Expand to full coverage and add OPA unit tests.
- **Files to modify:**
  - `policies/marketplace.rego` (expand to all 37 actions with correct RBAC)
  - `policies/test/marketplace_test.rego` (create OPA unit tests)
  - `docker-compose.yml` (add OPA sidecar port 8181)
- **Acceptance Criteria:**
  - [ ] All 37 known actions defined with matching RBAC rules
  - [ ] Context allowlist rules match TypeScript `CONTEXT_ALLOWLIST`
  - [ ] OPA unit tests pass: `opa test policies/`
  - [ ] OPA sidecar in docker-compose
  - [ ] No lint/type errors

---

### TASK-HARD-012: Owner mismatch moderator review workflow
- **Status:** backlog
- **Priority:** P1 — financial integrity
- **Assigned to:** —
- **Depends on:** TASK-HARD-003
- **Estimated effort:** 3-4 hours
- **Description:**
  OWNER_MISMATCH freezes payouts but there's no moderator resolution mechanism.
  Add list/clear/escalate endpoints.
- **Files to create/modify:**
  - `apps/api/src/services/moderation-service.ts` (create)
  - `apps/api/src/app.ts` (add 3 moderator routes)
  - `db/migrations/004_owner_mismatch_reviews.sql` (create)
- **New endpoints:**
  - `GET /v1/moderation/owner-mismatches` — list unresolved (moderator/admin)
  - `POST /v1/moderation/agents/:agentId/clear-owner-mismatch` — clear flag (moderator/admin)
  - `POST /v1/moderation/agents/:agentId/ban-owner-mismatch` — escalate to BAN (admin)
- **Acceptance Criteria:**
  - [ ] Mismatch flags persisted in PostgreSQL
  - [ ] List endpoint returns all unresolved mismatches
  - [ ] Clear: OWNER_MISMATCH removed from block reasons; payouts unblocked
  - [ ] Ban: immediate BAN sanction + audit event
  - [ ] Policy checks on all new routes
  - [ ] Tests: mismatch blocks payout; clear unblocks; ban applies sanction
  - [ ] No lint/type errors

---

### TASK-HARD-013: Moltbook token caching layer (Redis)
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** TASK-HARD-001, TASK-HARD-003
- **Estimated effort:** 2-3 hours
- **Description:**
  Every privileged route calls `assertFreshForPrivileged()` which reads the snapshot.
  In production, verify() would call Moltbook HTTP API — needs Redis caching.
- **Files to create/modify:**
  - `apps/api/src/adapters/moltbook-cache.ts` (create — Redis-backed caching layer)
  - `apps/api/src/adapters/moltbook-factory.ts` (modify — add cache wrap when Redis available)
- **Cache strategy:** Key: `moltbook:snapshot:{agentId}`, TTL = `trustedUntilAt - now`
- **Acceptance Criteria:**
  - [ ] Cache hit → zero external API calls
  - [ ] `reverify()` → cache invalidated before calling API
  - [ ] `REDIS_URL` unset → no caching (direct API calls)
  - [ ] Tests: cache hit, miss, and invalidation
  - [ ] No lint/type errors

---

### TASK-HARD-014: Moltbook webhook for real-time trust tier changes
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** TASK-HARD-001, TASK-HARD-003, TASK-HARD-013
- **Estimated effort:** 3-4 hours
- **Description:**
  Currently trust tier can only change when `verify()` is called. In production, trust changes
  (karma drop, suspension, owner change) must be applied immediately via webhook.
- **Files to create/modify:**
  - `apps/api/src/app.ts` (add `POST /v1/webhooks/moltbook`)
  - `apps/api/src/services/moltbook-webhook-service.ts` (create)
- **Events to handle:** `agent.trust_tier_changed`, `agent.suspended`, `agent.owner_changed`, `agent.unclaimed`
- **Acceptance Criteria:**
  - [ ] Moltbook-Signature header verified on all events
  - [ ] Trust tier changes update DB snapshot + invalidate Redis cache
  - [ ] `agent.suspended` event triggers immediate sanction
  - [ ] Replay protection via Redis event ID set
  - [ ] All webhook events emit audit events
  - [ ] Tests for all event types
  - [ ] No lint/type errors

---

## Feature Tasks

---

### TASK-FEAT-001: Custom milestone definitions in task creation
- **Status:** backlog
- **Priority:** P1
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2-3 hours
- **Description:**
  `acceptTask()` hardcodes 2 milestones with 50/50 split, ignoring `milestoneNames` input.
  Fix to support 1-10 custom milestones with optional custom amounts.
- **Files to modify:**
  - `apps/api/src/core/marketplace.ts` (`acceptTask()`)
  - `apps/api/src/app.ts` (`createTaskBodySchema`)
- **Acceptance Criteria:**
  - [ ] `milestoneNames` used when provided (1-10 milestones)
  - [ ] Budget split proportional to amounts if specified; equal split fallback
  - [ ] Validation: sum of milestone amounts === task.budget (if amounts provided)
  - [ ] Tests: 1 milestone, 3 milestones, custom amounts, budget mismatch rejected
  - [ ] No lint/type errors

---

### TASK-FEAT-002: Moltbook re-verify UI flow
- **Status:** backlog
- **Priority:** P1
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2-3 hours
- **Description:**
  When `needsReverifyPrompt=true` (50-60 min), show banner. When `expired=true` (>60 min),
  show blocking modal. Neither UI component exists today.
- **Files to create:**
  - `apps/web/components/ReverifyBanner.tsx`
  - `apps/web/components/ReverifyModal.tsx`
  - `apps/web/app/layout.tsx` (integrate)
  - `apps/web/app/api/bff/sessions/reverify/route.ts`
- **Acceptance Criteria:**
  - [ ] Banner on `needsReverifyPrompt=true`; modal (blocking) on `expired=true`
  - [ ] User pastes new token → `POST /api/bff/sessions/reverify`
  - [ ] Success: dismiss + session refreshed; failure: block reason shown
  - [ ] Tests: correct rendering in each state

---

### TASK-FEAT-003: Trust tier upgrade path endpoint + UI
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** TASK-HARD-001
- **Estimated effort:** 2-3 hours
- **Description:**
  Show Tier B/C agents what karma and activity they need to reach the next tier.
- **Files to create/modify:**
  - `apps/api/src/services/moltbook-identity-service.ts` (add `getTierUpgradePath()`)
  - `apps/api/src/app.ts` (add `GET /v1/agents/me/tier-upgrade`)
  - `apps/web/components/TrustTierCard.tsx`
- **Acceptance Criteria:**
  - [ ] Returns: currentTier, nextTier, karma gap, volume gap
  - [ ] Tier C shows path to both B and A
  - [ ] UI card with tier badge + progress
  - [ ] Tests: all three tier paths correct

---

### TASK-FEAT-004: Sanction appeal mechanism and suspension expiry
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** TASK-HARD-003, TASK-HARD-004
- **Estimated effort:** 3-4 hours
- **Description:**
  Suspended agents can appeal. Time-limited suspensions (168h) should auto-expire.
  Currently no background job exists for suspension expiry.
- **Files to create:**
  - `apps/api/src/services/sanction-service.ts`
  - `apps/worker/src/workflows/sanction-expiry.ts` (Temporal scheduled workflow)
  - New routes in `apps/api/src/app.ts`
- **Acceptance Criteria:**
  - [ ] `POST /v1/sanctions/:id/appeal` — file appeal
  - [ ] `POST /v1/sanctions/:id/review` — moderator ruling (uphold/reverse)
  - [ ] Temporal scheduled workflow runs every 15 min, expires past-duration suspensions
  - [ ] Expired suspension → agent.status = ACTIVE (if no remaining active sanctions)
  - [ ] All events audited
  - [ ] Tests: expiry, appeal flow, reversal reactivates agent

---

### TASK-FEAT-005: Full onboarding readiness widget (frontend)
- **Status:** backlog
- **Priority:** P1
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2-3 hours
- **Description:**
  The 7-item readiness checklist API exists but no frontend component.
- **Files to create:**
  - `apps/web/components/OnboardingChecklist.tsx`
  - `apps/web/app/onboarding/page.tsx`
  - `apps/web/app/api/bff/onboarding/readiness/route.ts`
- **Acceptance Criteria:**
  - [ ] 7 items with PASS/WARN/BLOCKED badges and details text
  - [ ] Blockers shown with actionable messages
  - [ ] CTA buttons for incomplete steps
  - [ ] Auto-refresh every 30 seconds

---

### TASK-FEAT-006: Audit chain verification endpoint
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2 hours
- **Description:**
  Moderators/admins need to verify the audit chain integrity for dispute evidence validation.
- **Files to modify:**
  - `apps/api/src/core/events.ts` (add `verifyChain()`)
  - `apps/api/src/app.ts` (add `GET /v1/events/verify`)
- **Acceptance Criteria:**
  - [ ] Returns `{ valid, totalEvents, firstBreakAt?, breakReason? }`
  - [ ] Re-computes each hash; verifies `previousHash` linkage
  - [ ] Tests: clean chain valid; tampered event detected at correct position
  - [ ] No lint/type errors

---

## Test Tasks

---

### TASK-TEST-001: Full integration tests for Moltbook identity flows
- **Status:** backlog
- **Priority:** P0
- **Assigned to:** —
- **Depends on:** TASK-HARD-001
- **Estimated effort:** 3-4 hours
- **Files to create:**
  - `apps/api/__tests__/moltbook-identity.test.ts`
  - `apps/api/__tests__/moltbook-freshness.test.ts`
  - `apps/api/__tests__/worker-eligibility.test.ts`
- **Acceptance Criteria:**
  - [ ] Tier A/B/C tokens produce correct eligibility matrix (`canBid`, `canReserve`, `canPayout`)
  - [ ] All 9 block reason codes individually tested
  - [ ] Owner mismatch: detected on reverify; payouts frozen; cleared by moderator
  - [ ] Identity freshness windows: fresh (0-50m) allowed; prompt (50-60m) allowed with flag; expired (>60m) blocked
  - [ ] Full onboarding: start → verify → capabilities → constitution → readiness all PASS
  - [ ] Sanctioned agent: all canBid/canReserve/canPayout = false
  - [ ] All tests pass with `npm test`

---

### TASK-TEST-002: Full integration tests for task lifecycle
- **Status:** backlog
- **Priority:** P0
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 3-4 hours
- **Files to create:**
  - `apps/api/__tests__/task-lifecycle.test.ts`
  - `apps/api/__tests__/dispute-lifecycle.test.ts`
- **Acceptance Criteria:**
  - [ ] Happy path: DRAFT → POSTED → bid → reserve → heartbeat → accept → start → deliver → accept → payout
  - [ ] Lease expiry → task rolls back to POSTED
  - [ ] Self-reserve blocked (requester cannot reserve own task)
  - [ ] Tier C worker cannot reserve → WORKER_RESERVE_BLOCKED
  - [ ] Concurrency limit: worker at maxConcurrency cannot reserve additional tasks
  - [ ] Capability mismatch → CAPABILITY_MISMATCH
  - [ ] Dispute → appeal → moderator ruling → sanction applied → audit events emitted in order
  - [ ] Split ruling: 50/50 distribution verified with correct rounding
  - [ ] All audit events emitted in correct sequence with valid hash chain
  - [ ] All tests pass with `npm test`

---

## Completed Tasks
[Moved here when status reaches "done"]
