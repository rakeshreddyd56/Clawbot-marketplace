/**
 * TASK-HARD-012: Owner mismatch moderator review workflow
 *
 * Tests:
 * 1. Owner mismatch is detected and persisted as a flag on reverify
 * 2. Mismatch blocks payout (existing behavior confirmed)
 * 3. GET /v1/moderation/owner-mismatches lists unresolved flags (moderator/admin)
 * 4. POST /v1/moderation/agents/:agentId/clear-owner-mismatch clears flag, unblocks payout
 * 5. POST /v1/moderation/agents/:agentId/ban-owner-mismatch applies BAN sanction
 * 6. Workers/requesters cannot access moderation routes (403)
 * 7. Clearing when no flag → 404
 * 8. Audit events emitted for detect/clear/ban
 * 9. Ban route is admin-only (moderators get 403)
 * 10. Flag auto-persisted on identity verify (callback integration)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../src/app.js';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent, topup } from './helpers.js';

describe('TASK-HARD-012: Owner mismatch moderator review workflow', () => {
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

  /**
   * Helper: onboard agent, then reverify with a different owner handle to trigger mismatch.
   * Uses FakeMoltbookVerifier's `owner_alt_` prefix to produce a different ownerXHandle
   * for the same agentId.
   */
  async function createMismatchedAgent(): Promise<{ agentId: string }> {
    // First verification — establishes the historical owner handle
    const agent = await onboardAgent(app, {
      tokenSeed: 'mismatch_worker',
      role: 'worker',
      capabilities: ['python']
    });

    // Reverify with different owner handle (triggers mismatch detection)
    const reverify = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_owner_alt_mismatch_worker',
        audience: 'clawbot.marketplace.local'
      }
    });
    expect(reverify.statusCode).toBe(200);

    return agent;
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1. Mismatch detection creates a persistent flag
  // ──────────────────────────────────────────────────────────────────────
  it('detects owner mismatch and persists flag on reverify', async () => {
    const { agentId } = await createMismatchedAgent();

    // Flag should be persisted in the store
    const flags = [...services.store.ownerMismatchFlags.values()];
    const agentFlags = flags.filter((f) => f.agentId === agentId && !f.resolvedAt);
    expect(agentFlags.length).toBe(1);
    expect(agentFlags[0].previousHandle).toBeTruthy();
    expect(agentFlags[0].newHandle).toBeTruthy();
    expect(agentFlags[0].previousHandle).not.toBe(agentFlags[0].newHandle);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. Mismatch blocks payout
  // ──────────────────────────────────────────────────────────────────────
  it('owner mismatch blocks payout request', async () => {
    const { agentId } = await createMismatchedAgent();

    // Fund the worker's wallet via admin
    await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: { 'x-agent-id': agentId, 'x-role': 'admin' },
      payload: { amount: 100 }
    });

    // Attempt payout — should be blocked by OWNER_MISMATCH
    const payout = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(agentId, 'worker'),
      payload: { amount: 50 }
    });

    expect(payout.statusCode).toBe(403);
    expect(payout.json<{ error: { code: string } }>().error.code).toBe('PAYOUT_BLOCKED');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. List unresolved mismatches (moderator)
  // ──────────────────────────────────────────────────────────────────────
  it('moderator can list unresolved owner mismatches', async () => {
    const { agentId } = await createMismatchedAgent();

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_list_mismatch',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches',
      headers: authHeaders(moderator.agentId, 'moderator')
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ mismatches: Array<{ agentId: string; flagId: string }> }>();
    expect(body.mismatches.length).toBeGreaterThanOrEqual(1);
    const agentMismatch = body.mismatches.find((m) => m.agentId === agentId);
    expect(agentMismatch).toBeTruthy();
    expect(agentMismatch!.flagId).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Admin can list unresolved mismatches
  // ──────────────────────────────────────────────────────────────────────
  it('admin can list unresolved owner mismatches', async () => {
    await createMismatchedAgent();

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_list_mismatch',
      role: 'admin',
      capabilities: ['admin']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches',
      headers: authHeaders(admin.agentId, 'admin')
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ mismatches: unknown[] }>().mismatches.length).toBeGreaterThanOrEqual(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Clear mismatch unblocks payouts
  // ──────────────────────────────────────────────────────────────────────
  it('clearing owner mismatch unblocks payouts', async () => {
    const { agentId } = await createMismatchedAgent();

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_clear_mismatch',
      role: 'moderator',
      capabilities: ['moderation']
    });

    // Fund the worker's wallet via admin
    await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: { 'x-agent-id': agentId, 'x-role': 'admin' },
      payload: { amount: 100 }
    });

    // Verify payout is blocked before clearing
    const payoutBefore = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(agentId, 'worker'),
      payload: { amount: 50 }
    });
    expect(payoutBefore.statusCode).toBe(403);

    // Clear the mismatch flag
    const clearRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { notes: 'Verified legitimate ownership transfer' }
    });

    expect(clearRes.statusCode).toBe(200);
    const clearBody = clearRes.json<{ cleared: boolean; flagId: string }>();
    expect(clearBody.cleared).toBe(true);
    expect(clearBody.flagId).toBeTruthy();

    // Verify payout is now unblocked
    const payoutAfter = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(agentId, 'worker'),
      payload: { amount: 50 }
    });
    expect(payoutAfter.statusCode).toBe(200);
    expect(payoutAfter.json<{ status: string }>().status).toBe('pending');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. Ban escalation applies BAN sanction
  // ──────────────────────────────────────────────────────────────────────
  it('admin ban escalation applies BAN sanction and updates agent status', async () => {
    const { agentId } = await createMismatchedAgent();

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_ban_mismatch',
      role: 'admin',
      capabilities: ['admin']
    });

    const banRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: { notes: 'Confirmed fraudulent account takeover' }
    });

    expect(banRes.statusCode).toBe(200);
    const banBody = banRes.json<{ banned: boolean; flagId: string; sanctionId: string }>();
    expect(banBody.banned).toBe(true);
    expect(banBody.flagId).toBeTruthy();
    expect(banBody.sanctionId).toBeTruthy();

    // Verify agent status is BANNED
    const profile = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(agentId, 'worker')
    });
    expect(profile.json<{ status: string }>().status).toBe('BANNED');

    // Verify BAN sanction exists
    const sanctions = services.store.sanctions.get(agentId) ?? [];
    const banSanction = sanctions.find((s) => s.type === 'BAN' && s.reasonCode === 'OWNER_MISMATCH_ESCALATION');
    expect(banSanction).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. Workers cannot access moderation routes (403)
  // ──────────────────────────────────────────────────────────────────────
  it('workers are denied access to moderation list route', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_no_mod',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 8. Requesters cannot access moderation routes (403)
  // ──────────────────────────────────────────────────────────────────────
  it('requesters are denied access to clear route', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_no_mod',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/moderation/agents/some-agent/clear-owner-mismatch',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {}
    });

    expect(res.statusCode).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 9. Moderators cannot ban (admin-only)
  // ──────────────────────────────────────────────────────────────────────
  it('moderators are denied access to ban route (admin-only)', async () => {
    const { agentId } = await createMismatchedAgent();

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_no_ban',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { notes: 'Attempting ban as moderator' }
    });

    expect(res.statusCode).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 10. Clearing non-existent mismatch returns 404
  // ──────────────────────────────────────────────────────────────────────
  it('clearing mismatch for agent with no flag returns 404', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_clear_nonexist',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const cleanAgent = await onboardAgent(app, {
      tokenSeed: 'clean_agent_nomod',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${cleanAgent.agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {}
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('MISMATCH_NOT_FOUND');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 11. Audit events emitted for detection, clear, and ban
  // ──────────────────────────────────────────────────────────────────────
  it('emits audit events for mismatch detect, clear, and ban', async () => {
    const { agentId } = await createMismatchedAgent();

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_audit_events',
      role: 'admin',
      capabilities: ['admin']
    });

    // Check detection audit event
    const allEvents = services.audit.getAll();
    const detectEvents = allEvents.filter(
      (e) => e.eventType === 'moderation.owner_mismatch.detected' && e.entityId === agentId
    );
    expect(detectEvents.length).toBeGreaterThanOrEqual(1);

    // Clear the mismatch
    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: { notes: 'Legitimate transfer' }
    });

    const afterClear = services.audit.getAll();
    const clearEvents = afterClear.filter(
      (e) => e.eventType === 'moderation.owner_mismatch.cleared' && e.entityId === agentId
    );
    expect(clearEvents.length).toBe(1);

    // Trigger mismatch again by reverifying with the ORIGINAL token.
    // After clearing, historicalOwnerHandles was updated to the owner_alt_ handle.
    // So reverifying with the original token (which produces the original ownerXHandle)
    // triggers a NEW mismatch against the now-accepted owner_alt_ handle.
    await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_mismatch_worker',
        audience: 'clawbot.marketplace.local'
      }
    });

    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: { notes: 'Repeated mismatch' }
    });

    const afterBan = services.audit.getAll();
    const banEvents = afterBan.filter(
      (e) => e.eventType === 'moderation.owner_mismatch.banned' && e.entityId === agentId
    );
    expect(banEvents.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 12. Cleared flag disappears from list
  // ──────────────────────────────────────────────────────────────────────
  it('cleared mismatch no longer appears in unresolved list', async () => {
    const { agentId } = await createMismatchedAgent();

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_cleared_list',
      role: 'moderator',
      capabilities: ['moderation']
    });

    // Verify flag appears in list
    const listBefore = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches',
      headers: authHeaders(moderator.agentId, 'moderator')
    });
    const before = listBefore.json<{ mismatches: Array<{ agentId: string }> }>();
    expect(before.mismatches.some((m) => m.agentId === agentId)).toBe(true);

    // Clear it
    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {}
    });

    // Verify flag no longer in list
    const listAfter = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches',
      headers: authHeaders(moderator.agentId, 'moderator')
    });
    const after = listAfter.json<{ mismatches: Array<{ agentId: string }> }>();
    expect(after.mismatches.some((m) => m.agentId === agentId)).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 13. Idempotent mismatch flag creation (duplicate reverify)
  // ──────────────────────────────────────────────────────────────────────
  it('duplicate mismatch reverify does not create multiple flags', async () => {
    const { agentId } = await createMismatchedAgent();

    // Reverify again with same mismatched handle
    await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_owner_alt_mismatch_worker',
        audience: 'clawbot.marketplace.local'
      }
    });

    const flags = [...services.store.ownerMismatchFlags.values()];
    const agentFlags = flags.filter((f) => f.agentId === agentId && !f.resolvedAt);
    expect(agentFlags.length).toBe(1);
  });
});
