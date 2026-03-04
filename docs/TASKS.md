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

## Security Audit Results (2026-03-02)

**Auditor:** security agent
**Status:** DEPLOYMENT BLOCKED — 7 Critical vulnerabilities found
**Report:** `reviews/security-audit-full.md`

### Critical Findings Requiring Immediate Fix (P0)
- VULN-01: Header-based auth bypass (remove `parseAuthContext` fallback) → TASK-HARD-007
- VULN-02: Non-timing-safe lease token comparison (use `crypto.timingSafeEqual`)
- VULN-03: Deterministic delivery secret (generate random per-milestone secrets) → TASK-HARD-010
- VULN-04: No Stripe webhook HMAC verification → TASK-HARD-005
- VULN-05: Unauthenticated WebSocket endpoints
- VULN-06: Legacy deliver/accept routes bypass all policy enforcement
- VULN-07: Artifact finalize() validates signature by string length only → TASK-HARD-010

### High Priority Findings (P1)
- VULN-08: Hardcoded JWT fallback secret → TASK-HARD-008
- VULN-09: Session cookies not Secure → TASK-HARD-008
- VULN-10: Session exchange allows self-assigning admin/moderator role
- VULN-11: OPA Rego bundle not integrated (dead code) → TASK-HARD-011
- VULN-12: Requester bypasses Trust Tier C payout restriction
- VULN-13: CORS wildcard origin with credentials
- VULN-14: Progressive sanction escalation logic bug

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
- **Status:** done
- **Priority:** P0 — financial correctness
- **Assigned to:** coder-1, coder-2
- **Depends on:** —
- **Estimated effort:** 3-4 hours
- **Description:**
  Every credit/debit pair must be tested. Balance invariants must be proven.
- **Files created:**
  - `apps/api/test/escrow.test.ts` (9 tests — escrow lock, release, slash, dispute resolution, double-spend, invariants)
  - `apps/api/test/ledger.test.ts` (9 tests — DEBIT/CREDIT entries, balance matching, isolation, ordering)
- **Acceptance Criteria:**
  - [x] Test: `acceptTask()` → requester debited, escrow credited (amounts match `task.budget`)
  - [x] Test: `acceptMilestone()` → escrow debited, worker credited (correct amount)
  - [x] Test: `resolveDispute('pay_worker')` → full escrow to worker
  - [x] Test: `resolveDispute('refund_requester')` → full escrow to requester
  - [x] Test: `resolveDispute('split')` → 50/50 with correct rounding
  - [x] Test: slash → `treasury:slashing` credited correctly
  - [x] Test: double-spend prevention — insufficient balance → 409
  - [x] Test: balance never goes negative across any sequence
  - [x] Test: `EscrowLock.status` transitions (LOCKED → PARTIAL_RELEASED → RELEASED → SLASHED)
  - [x] All tests pass with `npm test`

---

### TASK-HARD-007: Remove or gate header-based auth (privilege escalation vector)
- **Status:** review
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
- **Status:** review
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
- **Status:** review
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
- **Status:** done
- **Priority:** P2
- **Assigned to:** devops
- **Depends on:** —
- **Estimated effort:** 2-3 hours
- **Description:**
  `policies/marketplace.rego` defines only 10 of the 37 known actions.
  Expand to full coverage and add OPA unit tests.
- **Files created/modified:**
  - `policies/marketplace.rego` (previously expanded to all 37 actions by devops)
  - `policies/test/marketplace_test.rego` (created — ~120 OPA unit tests, 10 test groups)
  - `docker-compose.yml` (OPA sidecar already present on port 8181)
  - `.env.example` (expanded with Moltbook webhook, Kafka, OTel, CORS, Temporal TLS vars)
  - `infra/k8s/base/secrets.yaml` (created — K8s Secret templates for all 4 secret groups)
  - `db/migrations/001_initial_schema.sql` (created — full domain schema, 15+ tables)
  - `db/migrations/002_agent_owner_history.sql` (created — CRITICAL owner mismatch persistence)
  - `db/migrations/003_audit_ledger.sql` (created — immutable hash-chained audit events + triggers)
  - `db/migrations/004_owner_mismatch_reviews.sql` (created — moderation queue view)
  - `db/init/000_run_migrations.sh` (created — Docker Compose init entrypoint)
  - `db/seed.sql` (created — dev seed data: 4 agents, balances, tasks, snapshots)
  - `infra/k8s/overlays/staging/kustomization.yaml` (created — reduced replicas, develop tags)
  - `infra/k8s/overlays/production/kustomization.yaml` (created — 3x replicas, SHA pinning)
- **Acceptance Criteria:**
  - [x] All 37 known actions defined with matching RBAC rules
  - [x] Trust tier C restrictions enforced (task.reserve, wallet.payout, vault.token.issue, escrow.*)
  - [x] Identity freshness guards on all 7 privileged actions (15-min window)
  - [x] OPA unit tests: ~120 tests covering all 4 roles, 3 tiers, 4 deny_reason codes, boundary times
  - [x] OPA sidecar in docker-compose on port 8181
  - [x] Kubernetes secrets scaffold + ESO template for production secrets management

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
- **Status:** review
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
- **Status:** done
- **Priority:** P1
- **Assigned to:** ui-builder
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
- **Status:** done (UI only — API endpoint remains for backend agent)
- **Priority:** P2
- **Assigned to:** ui-builder
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
- **Status:** done
- **Priority:** P1
- **Assigned to:** ui-builder
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
- **Status:** review
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

## Bug Fix Tasks (from Security Audit + Code Review 2026-03-02)

> These tasks were catalogued by the architect agent from `reviews/security-audit-full.md` and `reviews/review-full-codebase-2026-03-02.md`. Each has a corresponding task on the project dashboard.

---

### BUG-CRIT-001: Fix unauthenticated WebSocket endpoints
- **Status:** review
- **Priority:** P0 — CRITICAL, deployment blocker
- **Assigned to:** coder
- **Depends on:** —
- **Estimated effort:** 1 hour
- **Description:**
  `/v1/events/ws` and `/v1/realtime` WebSocket handlers have **no authentication check**.
  Any anonymous client can connect and receive ALL audit events, including wallet amounts,
  dispute rulings, agent identities, and contract financials.
- **Files to modify:**
  - `apps/api/src/app.ts` (lines 973-1014)
- **Fix:**
  ```typescript
  app.get('/v1/events/ws', { websocket: true }, (socket, request) => {
    const actor = auth(request);  // ADD THIS
    enforcePolicy(services, actor, 'audit.read');  // ADD THIS
    ...
  });
  app.get('/v1/realtime', { websocket: true }, (socket, request) => {
    const actor = auth(request);  // ADD THIS
    enforcePolicy(services, actor, 'audit.read');  // ADD THIS — or 'realtime.subscribe'
    ...
  });
  ```
- **Acceptance Criteria:**
  - [ ] Unauthenticated WebSocket connection → 401 error (connection refused)
  - [ ] Valid session token → connection accepted
  - [ ] Non-admin cannot subscribe to another agent's entity events
  - [ ] Tests: anon connection rejected; auth connection accepted; entity filter enforced

---

### BUG-HIGH-001: Fix CORS wildcard origin with credentials (CSRF risk)
- **Status:** backlog
- **Priority:** P1 — HIGH, deployment blocker
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 30 minutes
- **Description:**
  `@fastify/cors` registered with `origin: true` (reflects any Origin header) and
  `credentials: true`. Any attacker-controlled website can make credentialed
  cross-origin requests using a victim's session cookie, enabling CSRF on financial
  endpoints (topup, payout, milestone accept).
- **Files to modify:**
  - `apps/api/src/app.ts` (lines 448-451)
  - `.env.example` (add `ALLOWED_ORIGINS`)
- **Fix:**
  ```typescript
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3001'],
    credentials: true
  });
  ```
- **Acceptance Criteria:**
  - [ ] Unknown Origin header → CORS rejected (no ACAO header)
  - [ ] `http://localhost:3001` → accepted
  - [ ] `ALLOWED_ORIGINS` env var configures allowed list
  - [ ] Tests: allowed origin accepted; unknown origin rejected

---

### BUG-HIGH-002: Fix legacy deliver/accept routes bypassing policy + freshness checks
- **Status:** backlog
- **Priority:** P1 — HIGH, deployment blocker
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 1 hour
- **Description:**
  `POST /v1/contracts/:contractId/deliver` and `POST /v1/contracts/:contractId/accept`
  (lines 815-837 in `app.ts`) skip both `enforcePolicy()` and `enforceFreshIdentity()`.
  This means: (1) no `PolicyDecision` record is written for milestone delivery/acceptance
  (which releases escrow funds), and (2) a stale/expired Moltbook verification bypasses
  the freshness gate for financial operations.
- **Files to modify:**
  - `apps/api/src/app.ts` (lines 815-837)
- **Fix:** Add `enforcePolicy` + `enforceFreshIdentity` to both routes, OR deprecate
  and remove the legacy routes entirely (preferred since per-milestone routes cover both).
- **Acceptance Criteria:**
  - [ ] `POST /v1/contracts/:id/deliver` with expired Moltbook → 401 REVERIFY_REQUIRED
  - [ ] `POST /v1/contracts/:id/accept` with expired Moltbook → 401 REVERIFY_REQUIRED
  - [ ] PolicyDecision record written for both operations
  - [ ] Tests: expired session rejected; valid session accepted; audit records present

---

### BUG-HIGH-003: Fix moderator can slash/sanction arbitrary agents
- **Status:** done
- **Priority:** P1 — HIGH, deployment blocker
- **Assigned to:** security-auditor
- **Depends on:** —
- **Estimated effort:** 30 minutes
- **Description:**
  `resolveDispute()` in `marketplace.ts` accepts any `targetAgentId` from the request body
  without validating it is a party to the dispute. A malicious or compromised moderator
  account can slash the balance and apply SUSPEND/BAN sanctions to **any agent in the
  marketplace** by targeting arbitrary `agentId` values.
- **Files to modify:**
  - `apps/api/src/core/marketplace.ts` (lines 556-638)
- **Fix:**
  ```typescript
  // Add this assertion at the top of resolveDispute():
  assertDomain(
    targetAgentId === contract.requesterAgentId || targetAgentId === contract.workerAgentId,
    'INVALID_TARGET_AGENT',
    'Target agent must be a party to the dispute contract.',
    400
  );
  ```
- **Acceptance Criteria:**
  - [x] `targetAgentId` not party to dispute → 400 INVALID_TARGET_AGENT
  - [x] `targetAgentId` = requesterAgentId → sanction applied correctly
  - [x] `targetAgentId` = workerAgentId → sanction applied correctly
  - [x] Tests: non-party agent ID rejected; both valid parties accepted

---

### BUG-MED-001: Fix lease token comparison not timing-safe
- **Status:** backlog
- **Priority:** P1
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 30 minutes
- **Description:**
  `verifyLeaseToken()` in `marketplace.ts` uses `assertDomain(current === token, ...)` —
  plain JavaScript string equality that short-circuits on first differing character.
  This is susceptible to timing oracle attacks allowing token enumeration.
  `@claw/utils` exports `verifyWithSecret()` which already uses `crypto.timingSafeEqual`.
- **Files to modify:**
  - `apps/api/src/core/marketplace.ts` (lines 747-749)
- **Fix:**
  ```typescript
  import { timingSafeEqual } from 'crypto';
  private verifyLeaseToken(leaseId: string, token: string): void {
    const current = this.leaseSecrets.get(leaseId);
    assertDomain(Boolean(current), 'LEASE_TOKEN_MISSING', 'Lease token missing.', 401);
    const valid = timingSafeEqual(Buffer.from(current!), Buffer.from(token));
    assertDomain(valid, 'LEASE_TOKEN_INVALID', 'Invalid lease token.', 401);
  }
  ```
- **Acceptance Criteria:**
  - [ ] Correct token → accepted
  - [ ] Wrong token → 401 (consistent timing)
  - [ ] Uses `crypto.timingSafeEqual` or equivalent

---

### BUG-MED-002: Fix evidence endpoint leaks global policy decisions
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 1 hour
- **Description:**
  `GET /v1/disputes/:disputeId/evidence` returns `services.store.policyDecisions.slice(-50)` —
  the last 50 GLOBAL policy decisions, not filtered to this dispute or its contract parties.
  Any dispute party can see policy decisions from other agents' activities, leaking usage
  patterns and timing across the platform.
- **Files to modify:**
  - `apps/api/src/app.ts` (line 903)
- **Fix:**
  ```typescript
  // Filter to only decisions for this dispute's parties:
  policyDecisions: services.store.policyDecisions.filter(d =>
    d.actorAgentId === contract.requesterAgentId ||
    d.actorAgentId === contract.workerAgentId ||
    d.entityId === dispute.disputeId ||
    d.entityId === contract.contractId
  ).slice(-50)
  ```
- **Acceptance Criteria:**
  - [ ] Evidence endpoint only returns decisions for dispute parties
  - [ ] Admin/moderator can see all decisions
  - [ ] Tests: party sees only own decisions; unrelated decisions excluded

---

### BUG-MED-003: Fix task.accept and 6 routes missing from PolicyDecisionService
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 2 hours
- **Description:**
  Architecture rule: "All API routes MUST check policy via PolicyDecisionService."
  Violations:
  1. `POST /v1/tasks/:taskId/accept` — uses `PolicyEngine.enforce()` internally,
     not `PolicyDecisionService`. No `PolicyDecision` record created for contract creation.
  2. Six routes with no `enforcePolicy()` call at all:
     - `GET /v1/tasks/:taskId/eligibility`
     - `POST /v1/tasks/:taskId/accept` (the accept endpoint itself)
     - `GET /v1/disputes/:disputeId`
     - `GET /v1/disputes/:disputeId/evidence`
     - `POST /v1/tasks/:taskId/vault-token`
     - `POST /v1/contracts/:contractId/signature-preview`
- **Files to modify:**
  - `apps/api/src/core/policy-decision.ts` (add `task.accept`, `task.eligibility.read`,
    `dispute.read`, `dispute.evidence.read`, `vault.token.create`, `artifact.signature.preview`
    to `KNOWN_ACTIONS`)
  - `apps/api/src/app.ts` (add `enforcePolicy` calls to all 6 routes)
- **Acceptance Criteria:**
  - [ ] All 6 routes emit `PolicyDecision` records
  - [ ] `task.accept` action in KNOWN_ACTIONS with correct RBAC
  - [ ] Deny-by-default still applies to unknown actions
  - [ ] Tests: policy decisions recorded for all previously-missing routes

---

### BUG-MED-004: Fix VaultService accepts CLOSED lease status
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 30 minutes
- **Description:**
  `vault-service.ts` line 16 asserts `lease.status === 'ACTIVE' || lease.status === 'CLOSED'`.
  Leases are set to CLOSED when a contract is created (`acceptTask`). This allows vault tokens
  to be issued after the lease lifecycle has ended. While the upstream `getScopeForLease()`
  guard (requires ACTIVE) prevents exploitation in the current call chain, direct calls
  to `VaultService.issueVaultToken()` would bypass this.
- **Files to modify:**
  - `apps/api/src/services/vault-service.ts` (line 16)
- **Fix:** Remove `|| lease!.status === 'CLOSED'` — only ACTIVE leases should grant vault tokens.
- **Acceptance Criteria:**
  - [ ] Vault token request with CLOSED lease → 409 LEASE_INACTIVE
  - [ ] Vault token request with ACTIVE lease → 200 OK
  - [ ] Tests: closed lease rejected

---

### BUG-MED-005: Add treasury counterparty entries for wallet topup/payout
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 1 hour
- **Description:**
  CLAUDE.md rule: "All escrow operations MUST be balanced (every DEBIT has a corresponding CREDIT)."
  `topup()` credits `actorAgentId` with no corresponding debit from any account.
  `payout()` debits `actorAgentId` with no corresponding credit to any account.
  The internal ledger cannot reconcile to zero for external monetary flows.
- **Files to modify:**
  - `apps/api/src/core/marketplace.ts` (lines 149-159, 896-902)
- **Fix:**
  ```typescript
  // topup: debit from treasury:inbound first
  this.credit('treasury:inbound', amount, 'wallet.topup', 'topup', resp.topupId);
  this.debit('treasury:inbound', amount, 'wallet.topup', 'topup', resp.topupId);  // or reverse
  // payout: credit to treasury:outbound
  this.debit(actor.actorAgentId, amount, 'wallet.payout_request', 'payout', payout.payoutId);
  this.credit('treasury:outbound', amount, 'wallet.payout_request', 'payout', payout.payoutId);
  ```
- **Acceptance Criteria:**
  - [ ] After topup: DEBIT(`treasury:inbound`, amount) + CREDIT(`actorAgentId`, amount)
  - [ ] After payout: DEBIT(`actorAgentId`, amount) + CREDIT(`treasury:outbound`, amount)
  - [ ] Sum of all ledger entries = 0 across all accounts
  - [ ] Tests: ledger sums to zero after complete topup+task+payout cycle

---

### BUG-MED-006: Fix ReputationService stale cache never invalidated
- **Status:** backlog
- **Priority:** P2
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 1 hour
- **Description:**
  `ReputationService.get()` returns a cached reputation score forever after the first
  computation — even after new milestones are accepted, disputes are finalized, or
  sanctions are applied. All subsequent calls return stale data.
- **Files to modify:**
  - `apps/api/src/services/reputation-service.ts` (lines 8-10)
  - `apps/api/src/core/marketplace.ts` (or `AuditLedger` subscriber — add cache invalidation)
- **Fix Options:**
  1. Remove the early-return cache entirely (recompute on every `get()` call)
  2. Subscribe to audit events: invalidate on `milestone.accepted`, `dispute.resolved`,
     `sanction.applied` event types
- **Acceptance Criteria:**
  - [ ] Reputation score updates after milestone accepted
  - [ ] Reputation score updates after dispute lost (sanction)
  - [ ] `GET /v1/reputation/:agentId` returns current score, not stale data
  - [ ] Tests: score stale before fix; correct after fix

---

### BUG-MIN-001: Fix workflow state machine transition bugs
- **Status:** backlog
- **Priority:** P3
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 30 minutes
- **Description:**
  Two workflow state machine bugs that will cause Temporal replay desync when
  the real Temporal worker is wired in (TASK-HARD-004):
  1. `disputeResolutionTransition` with `auto_decide` command returns `DISPUTE_OPEN`
     (no-op) but the domain creates disputes as `AUTO_DECIDED` immediately.
     `WorkflowState` type is missing `DISPUTE_AUTO_DECIDED`.
  2. `taskLifecycleTransition` with `cancel` command returns `TASK_POSTED` but
     domain sets status to `CLOSED`. `WorkflowState` type is missing `TASK_CLOSED`.
- **Files to modify:**
  - `packages/workflows/src/index.ts` (lines 1-10, 22, 50)
- **Fix:**
  ```typescript
  export type WorkflowState =
    | 'TASK_POSTED' | 'TASK_RESERVED' | 'TASK_ASSIGNED' | 'TASK_CLOSED'  // ADD TASK_CLOSED
    | 'MILESTONE_RUNNING' | 'MILESTONE_DELIVERED' | 'MILESTONE_ACCEPTED'
    | 'DISPUTE_OPEN' | 'DISPUTE_AUTO_DECIDED'  // ADD DISPUTE_AUTO_DECIDED
    | 'DISPUTE_APPEAL' | 'DISPUTE_FINAL';

  // Fix cancel transition:
  if (command.type === 'cancel') return 'TASK_CLOSED';  // was TASK_POSTED

  // Fix auto_decide transition:
  if (state === 'DISPUTE_OPEN' && command.type === 'auto_decide') return 'DISPUTE_AUTO_DECIDED';
  ```
- **Acceptance Criteria:**
  - [ ] `TASK_CLOSED` and `DISPUTE_AUTO_DECIDED` added to `WorkflowState` type
  - [ ] `cancel` command → `TASK_CLOSED` (matches domain)
  - [ ] `auto_decide` command → `DISPUTE_AUTO_DECIDED` (matches domain)
  - [ ] Existing tests still pass

---

### BUG-MIN-002: Fix unvalidated agentId query parameter in eligibility routes
- **Status:** backlog
- **Priority:** P3
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 15 minutes
- **Description:**
  `GET /v1/tasks/:taskId/eligibility` (line 627) accesses `agentId` via raw cast
  (`String((request.query as Record<string, unknown>)?.agentId ?? '')`) bypassing Zod.
  `workerEligibilityQuerySchema` already defines `agentId: z.string().min(1).optional()`.
  Use the parsed result instead.
- **Files to modify:**
  - `apps/api/src/app.ts` (lines 621-629)
- **Fix:** Parse `request.query` with `workerEligibilityQuerySchema.parse(request.query)` and
  use `query.agentId` directly.
- **Acceptance Criteria:**
  - [ ] `agentId` query param validated via Zod schema
  - [ ] Invalid agentId format → 400 VALIDATION_ERROR
  - [ ] Consistent with project convention

---

### BUG-MIN-003: Fix BFF proxy path segments lack traversal protection
- **Status:** backlog
- **Priority:** P3
- **Assigned to:** —
- **Depends on:** —
- **Estimated effort:** 30 minutes
- **Description:**
  The catch-all BFF proxy at `apps/web/app/api/bff/[...path]/route.ts` constructs
  upstream URLs from path segments without checking for `..` or encoded traversal
  sequences (`%2F..%2F`). While low severity (apiBase is internal), it is inconsistent
  with project conventions.
- **Files to modify:**
  - `apps/web/app/api/bff/[...path]/route.ts`
- **Fix:** Add path segment validation before URL construction:
  ```typescript
  const sanitized = path.map(segment => {
    if (segment.includes('..') || segment.includes('%2F') || segment.includes('%2E')) {
      throw new Error('Invalid path segment');
    }
    return segment;
  });
  ```
- **Acceptance Criteria:**
  - [ ] `..` in path segment → 400 error
  - [ ] Encoded traversal sequences → 400 error
  - [ ] Valid paths → proxied correctly

---

## Completed Tasks
[Moved here when status reaches "done"]
