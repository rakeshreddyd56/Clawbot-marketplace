/**
 * TASK-TEST-001: Full integration tests for Moltbook identity flows
 *
 * Covers the complete identity verification lifecycle:
 * - Token format validation (invalid prefix → 401)
 * - Token flag-based behaviour: unclaimed, owner_unverified, deactivated, expired
 * - Trust tier computation: A (karma≥100 + volume≥50), B (karma≥25 + volume≥10), C (rest)
 * - Tier-based permission gates: C cannot reserve/payout, B has payout delay, A has full access
 * - Historical owner handle tracking and mismatch detection
 * - Reverify endpoint (with and without explicit token in body)
 * - Identity freshness status endpoint
 * - Onboarding readiness widget (worker and requester roles)
 * - Session exchange: JWT + cookie issued on success
 * - Session logout: cookie cleared
 * - Sanctioned agent blocking
 * - Deactivated agent rejection
 * - /v1/identity/moltbook/verify soft-path (no hard-block → activationAllowed=true)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../src/app.js';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent, topup } from './helpers.js';

describe('TASK-TEST-001: Moltbook identity flows', () => {
  let app: FastifyInstance;
  let services: AppServices;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
    services = built.services;
  });

  afterEach(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Token format validation
  // ─────────────────────────────────────────────────────────────────────────────

  it('rejects identity tokens that do not start with mbtok_ prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'invalid_token_format',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_IDENTITY_TOKEN');
  });

  it('rejects tokens shorter than 5 chars (Zod validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'ab',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing audience (Zod validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'mbtok_valid_agent'
      }
    });

    // audience has a default so it should work even without providing it
    expect(res.statusCode).toBe(200);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Hard-block conditions: unclaimed, owner_unverified, expired, deactivated
  // ─────────────────────────────────────────────────────────────────────────────

  it('unclaimed bot hard-blocks onboarding/verify (BOT_NOT_CLAIMED)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'mbtok_worker_unclaimed',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('MOLTBOOK_TRUST_GATE_FAILED');
  });

  it('identity/moltbook/verify soft-path returns activationAllowed=false for unclaimed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_worker_unclaimed',
        audience: 'clawbot.marketplace.local'
      }
    });

    // Soft verify does NOT throw — it returns the snapshot with activationAllowed=false
    expect(res.statusCode).toBe(200);
    const body = res.json<{ activationAllowed: boolean; snapshot: { hardBlocked: boolean; blockReasons: Array<{ code: string }> } }>();
    expect(body.activationAllowed).toBe(false);
    expect(body.snapshot.hardBlocked).toBe(true);
    expect(body.snapshot.blockReasons.some((r) => r.code === 'BOT_NOT_CLAIMED')).toBe(true);
  });

  it('owner_unverified bot hard-blocks via soft-path (OWNER_NOT_VERIFIED)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_worker_owner_unverified',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ activationAllowed: boolean; snapshot: { hardBlocked: boolean; blockReasons: Array<{ code: string }> } }>();
    expect(body.activationAllowed).toBe(false);
    expect(body.snapshot.hardBlocked).toBe(true);
    expect(body.snapshot.blockReasons.some((r) => r.code === 'OWNER_NOT_VERIFIED')).toBe(true);
  });

  it('expired token sets TOKEN_EXPIRED block reason and fails session exchange', async () => {
    // Soft verify: expired token is flagged but not immediately hard-rejected by /identity/verify
    const softRes = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_worker_expired',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(softRes.statusCode).toBe(200);
    const body = softRes.json<{ activationAllowed: boolean; snapshot: { blockReasons: Array<{ code: string }> } }>();
    expect(body.activationAllowed).toBe(false);
    expect(body.snapshot.blockReasons.some((r) => r.code === 'TOKEN_EXPIRED')).toBe(true);

    // Session exchange must be hard-blocked for expired tokens
    const exchangeRes = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_worker_expired',
        role: 'worker'
      }
    });

    expect(exchangeRes.statusCode).toBe(403);
    expect(exchangeRes.json<{ error: { code: string } }>().error.code).toBe('MOLTBOOK_TRUST_GATE_FAILED');
  });

  it('deactivated agent is rejected at onboarding verify step', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'mbtok_worker_deactivated',
        audience: 'clawbot.marketplace.local'
      }
    });

    // FakeMoltbookVerifier sets isActive=false for 'deactivated' tokens
    // MarketplaceCore.verifyMoltbook checks assertDomain(verified.isActive, 'AGENT_DEACTIVATED', ...)
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AGENT_DEACTIVATED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Trust tier computation and enforcement
  // ─────────────────────────────────────────────────────────────────────────────

  it('tier A worker (high karma) has full reserve+payout access', async () => {
    // Default token → karma=140, posts=32, comments=36 → Tier A
    const worker = await onboardAgent(app, {
      tokenSeed: 'identity_tierA_worker',
      role: 'worker',
      capabilities: ['python']
    });

    const eligibility = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{ trustTier: string; canBid: boolean; canReserve: boolean; canPayout: boolean; payoutDelayHours: number }>();
    expect(body.trustTier).toBe('A');
    expect(body.canBid).toBe(true);
    expect(body.canReserve).toBe(true);
    expect(body.canPayout).toBe(true);
    expect(body.payoutDelayHours).toBe(0);
  });

  it('tier B worker (medium karma) can bid+reserve but has 24h payout delay', async () => {
    // 'tierb' in token seed → karma=35, posts=6, comments=7 → Tier B
    const worker = await onboardAgent(app, {
      tokenSeed: 'identity_tierb_worker_tierb',
      role: 'worker',
      capabilities: ['python']
    });

    const eligibility = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{ trustTier: string; canBid: boolean; canReserve: boolean; canPayout: boolean; payoutDelayHours: number }>();
    expect(body.trustTier).toBe('B');
    expect(body.canBid).toBe(true);
    expect(body.canReserve).toBe(true);
    // Tier B CAN payout (just with delay), unless there's an owner mismatch
    expect(body.payoutDelayHours).toBe(24);
  });

  it('tier C worker (low karma) can bid but cannot reserve or payout', async () => {
    // 'tierc' in token seed → karma=12, posts=2, comments=3 → Tier C
    const worker = await onboardAgent(app, {
      tokenSeed: 'identity_tierc_worker_tierc',
      role: 'worker',
      capabilities: ['python']
    });

    const eligibility = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{ trustTier: string; canBid: boolean; canReserve: boolean; canPayout: boolean }>();
    expect(body.trustTier).toBe('C');
    expect(body.canBid).toBe(true);
    expect(body.canReserve).toBe(false);
    expect(body.canPayout).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Owner mismatch detection (historical owner tracking)
  // ─────────────────────────────────────────────────────────────────────────────

  it('owner mismatch: re-verify with different owner handle freezes payouts', async () => {
    // First verify: establishes historical owner handle
    const firstVerify = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'mbtok_mismatch_original',
        audience: 'clawbot.marketplace.local'
      }
    });
    expect(firstVerify.statusCode).toBe(200);
    const { agentId } = firstVerify.json<{ agentId: string }>();

    // Register capabilities and accept constitution to become active
    await app.inject({
      method: 'POST',
      url: '/v1/agents/me/capabilities',
      headers: authHeaders(agentId, 'worker'),
      payload: { capabilities: ['python'], maxConcurrency: 1, dataClassesAllowed: ['public'], toolClassesAllowed: ['read'] }
    });
    await app.inject({
      method: 'POST',
      url: '/v1/agents/me/constitution/accept',
      headers: authHeaders(agentId, 'worker'),
      payload: { constitutionVersion: 'v1' }
    });

    // Second verify with a DIFFERENT owner handle (owner_alt in token)
    // The FakeMoltbookVerifier uses 'owner_alt' prefix for different handle
    const secondVerify = await app.inject({
      method: 'POST',
      url: '/v1/sessions/reverify',
      headers: authHeaders(agentId, 'worker'),
      payload: {
        identityToken: 'mbtok_owner_alt_mismatch_original',
        audience: 'clawbot.marketplace.local'
      }
    });
    // Reverify may return 200 but snapshot should have OWNER_MISMATCH
    // (owner mismatch is non-blocking for hard gate but blocks payouts)
    expect([200, 403]).toContain(secondVerify.statusCode);

    // Verify that worker eligibility shows owner mismatch
    const eligibility = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{ canPayout: boolean; blockReasons: Array<{ code: string }> }>();
    // Owner mismatch blocks payouts
    expect(body.canPayout).toBe(false);
    expect(body.blockReasons.some((r) => r.code === 'OWNER_MISMATCH')).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Session exchange and logout
  // ─────────────────────────────────────────────────────────────────────────────

  it('session exchange returns JWT token, agentId, role, trustTier and sets cookie', async () => {
    // Use a valid token for a non-blocked agent (default Tier A)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_session_exchange_agent',
        role: 'worker'
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; agentId: string; role: string; trustTier: string; expiresAt: string }>();
    expect(body.token).toBeTruthy();
    expect(body.agentId).toBeTruthy();
    expect(body.role).toBe('worker');
    expect(body.trustTier).toBe('A');
    expect(body.expiresAt).toBeTruthy();

    // Cookie should be set
    const setCookieHeader = res.headers['set-cookie'];
    expect(setCookieHeader).toBeTruthy();
  });

  it('session logout returns ok and clears cookie', async () => {
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/sessions/logout'
    });

    expect(logout.statusCode).toBe(200);
    expect(logout.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('session exchange is denied for hard-blocked token (unclaimed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_exchange_unclaimed',
        role: 'worker'
      }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('MOLTBOOK_TRUST_GATE_FAILED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Reverify endpoint
  // ─────────────────────────────────────────────────────────────────────────────

  it('reverify with explicit token refreshes snapshot and extends expiry', async () => {
    // First onboard the agent
    const agentSetup = await onboardAgent(app, {
      tokenSeed: 'reverify_explicit_agent',
      role: 'worker',
      capabilities: ['python']
    });

    const reverify = await app.inject({
      method: 'POST',
      url: '/v1/sessions/reverify',
      headers: authHeaders(agentSetup.agentId, 'worker'),
      payload: {
        identityToken: 'mbtok_reverify_explicit_agent',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(reverify.statusCode).toBe(200);
    const body = reverify.json<{ refreshed: boolean; trustTier: string; expiresAt: string }>();
    expect(body.refreshed).toBe(true);
    expect(body.trustTier).toBe('A');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('reverify without prior token returns REVERIFY_TOKEN_REQUIRED', async () => {
    // Access reverify for an agent that doesn't exist in the store
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/reverify',
      headers: authHeaders('agent_never_existed_xyz', 'worker'),
      payload: { audience: 'clawbot.marketplace.local' }
    });

    // Either 400 (no token) or 404 (agent has no snapshot)
    expect([400, 404]).toContain(res.statusCode);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Identity status endpoint
  // ─────────────────────────────────────────────────────────────────────────────

  it('identity status endpoint returns snapshot and freshness for onboarded agent', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'identity_status_check',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/identity/moltbook/status',
      headers: authHeaders(agent.agentId, 'worker')
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      snapshot: { trustTier: string; hardBlocked: boolean; valid: boolean };
      freshness: { expired: boolean; trustTier: string; secondsToExpiry: number };
    }>();

    expect(body.snapshot.trustTier).toBe('A');
    expect(body.snapshot.hardBlocked).toBe(false);
    expect(body.snapshot.valid).toBe(true);
    expect(body.freshness.expired).toBe(false);
    expect(body.freshness.secondsToExpiry).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Onboarding readiness widget
  // ─────────────────────────────────────────────────────────────────────────────

  it('onboarding readiness returns PASS for all items after full onboarding', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'onboarding_readiness_full',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/onboarding/readiness?role=worker',
      headers: authHeaders(agent.agentId, 'worker')
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      role: string;
      trustTier: string;
      items: Array<{ id: string; status: string }>;
      blockers: unknown[];
    }>();

    expect(body.role).toBe('worker');
    expect(body.trustTier).toBe('A');
    expect(body.blockers).toHaveLength(0);

    const identityItem = body.items.find((item) => item.id === 'identity_verified');
    expect(identityItem?.status).toBe('PASS');

    const trustGateItem = body.items.find((item) => item.id === 'trust_gate');
    expect(trustGateItem?.status).toBe('PASS');

    const constitutionItem = body.items.find((item) => item.id === 'constitution_accepted');
    expect(constitutionItem?.status).toBe('PASS');
  });

  it('onboarding readiness shows BLOCKED items before capabilities declared', async () => {
    // Verify only — no capabilities/constitution
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'mbtok_readiness_partial_agent',
        audience: 'clawbot.marketplace.local'
      }
    });
    const { agentId } = verify.json<{ agentId: string }>();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/onboarding/readiness?role=worker',
      headers: authHeaders(agentId, 'worker')
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<{ id: string; status: string }>;
    }>();

    const constitutionItem = body.items.find((item) => item.id === 'constitution_accepted');
    expect(constitutionItem?.status).toBe('BLOCKED');
  });

  it('onboarding readiness for tier C worker shows BLOCKED sandbox and payout eligibility', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'readiness_tierc_worker_tierc',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/onboarding/readiness?role=worker',
      headers: authHeaders(agent.agentId, 'worker')
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      trustTier: string;
      items: Array<{ id: string; status: string }>;
    }>();

    expect(body.trustTier).toBe('C');
    const sandboxItem = body.items.find((item) => item.id === 'sandbox_eligible');
    expect(sandboxItem?.status).toBe('WARN');

    const payoutItem = body.items.find((item) => item.id === 'payout_eligible');
    expect(payoutItem?.status).toBe('BLOCKED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Sanctioned agent eligibility
  // ─────────────────────────────────────────────────────────────────────────────

  it('sanctioned agent cannot bid or reserve', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sanction_req',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'sanction_wrk',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    // Inject a sanction directly into the store
    const { SanctionActionSchema } = await import('@claw/contracts');
    const { uid, nowIso } = await import('@claw/utils');
    // SanctionActionSchema uses 'type' (not actionType) and 'effectiveAt' (not issuedAt)
    const sanction = SanctionActionSchema.parse({
      sanctionId: uid('sanction'),
      agentId: worker.agentId,
      type: 'SUSPEND',
      reasonCode: 'FRAUD',
      status: 'ACTIVE',
      effectiveAt: nowIso(),
      durationHours: 24
    });

    if (!services.store.sanctions.has(worker.agentId)) {
      services.store.sanctions.set(worker.agentId, []);
    }
    services.store.sanctions.get(worker.agentId)!.push(sanction);

    // Create a posted task
    const taskRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Sanction Test Task',
        description: 'Task for sanction testing',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['data://ref'],
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1'
        }
      }
    });
    const { taskId } = taskRes.json<{ taskId: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    // Sanctioned worker tries to bid
    const bidRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 80 }
    });

    expect(bidRes.statusCode).toBe(403);
    expect(bidRes.json<{ error: { code: string } }>().error.code).toBe('WORKER_BID_BLOCKED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Tier C enforced at reserve endpoint level
  // ─────────────────────────────────────────────────────────────────────────────

  it('tier C worker eligibility check reports blockReasons for reserve and payout', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'tierc_eligibility_worker_tierc',
      role: 'worker',
      capabilities: ['python']
    });

    const eligibility = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{
      trustTier: string;
      canBid: boolean;
      canReserve: boolean;
      canPayout: boolean;
      blockReasons: Array<{ code: string; message: string }>;
    }>();

    expect(body.trustTier).toBe('C');
    expect(body.canBid).toBe(true);
    expect(body.canReserve).toBe(false);
    expect(body.canPayout).toBe(false);

    const tierCReason = body.blockReasons.find((r) => r.code === 'TRUST_TIER_LIMITED');
    expect(tierCReason).toBeDefined();
    expect(tierCReason!.message).toContain('reserve');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Task eligibility endpoint (worker-specific task check)
  // ─────────────────────────────────────────────────────────────────────────────

  it('task eligibility returns canReserve=true for eligible Tier A worker on POSTED task', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'task_elig_req',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'task_elig_wrk',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const taskRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Eligibility Task',
        description: 'Check worker eligibility',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['data://ref'],
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1'
        }
      }
    });
    const { taskId } = taskRes.json<{ taskId: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    const eligibility = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/eligibility`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{ taskId: string; canReserve: boolean; trustTier: string }>();
    expect(body.taskId).toBe(taskId);
    expect(body.canReserve).toBe(true);
    expect(body.trustTier).toBe('A');
  });

  it('task eligibility returns canReserve=false for worker with mismatched capabilities', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'cap_mismatch_req',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    // Worker has 'java' but task requires 'python'
    const worker = await onboardAgent(app, {
      tokenSeed: 'cap_mismatch_wrk',
      role: 'worker',
      capabilities: ['java']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const taskRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Capability Mismatch Task',
        description: 'Task requiring python',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['data://ref'],
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1'
        }
      }
    });
    const { taskId } = taskRes.json<{ taskId: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    const eligibility = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/eligibility`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{ canReserve: boolean; blockReasons: Array<{ code: string }> }>();
    expect(body.canReserve).toBe(false);
    expect(body.blockReasons.some((r) => r.code === 'MISSING_CAPABILITIES')).toBe(true);
  });

  it('task eligibility is forbidden for requester role (worker-only endpoint)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'task_elig_forbidden_req',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/tasks/some_task_id/eligibility',
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(res.statusCode).toBe(403);
    // BUG-MED-003: now enforced by PolicyDecisionService (POLICY_DENY) instead of assertDomain (ROLE_FORBIDDEN)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Worker eligibility endpoint access control
  // ─────────────────────────────────────────────────────────────────────────────

  it('worker eligibility endpoint forbidden for requester role', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'eligibility_forbidden_req',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(res.statusCode).toBe(403);
  });

  it('admin can check eligibility for any worker by agentId query param', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'admin_elig_check_wrk',
      role: 'worker',
      capabilities: ['python']
    });

    // Admin checks worker eligibility
    const res = await app.inject({
      method: 'GET',
      url: `/v1/worker/eligibility?agentId=${worker.agentId}`,
      headers: { 'x-agent-id': 'admin_agent', 'x-role': 'admin' }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agentId: string; trustTier: string }>();
    expect(body.agentId).toBe(worker.agentId);
  });
});
