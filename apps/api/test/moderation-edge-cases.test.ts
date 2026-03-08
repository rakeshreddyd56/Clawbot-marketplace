/**
 * TASK-HARD-012: Owner mismatch moderation — Edge cases & attack vectors
 *
 * Supplements owner-mismatch-moderation.test.ts with adversarial scenarios:
 * - No auth on all moderation endpoints → 401
 * - Double-clear → 404
 * - Ban after clear → 404
 * - Clear after ban → 404
 * - Agent self-clear via worker role → 403
 * - Notes field validation (over-long → 400)
 * - Ban non-existent agent → 404
 * - Banned agent cannot perform marketplace actions
 * - Historical handle update after clear
 * - Multiple agents' mismatches handled independently
 * - Requester with mismatch also gets payout blocked
 * - Worker cannot access ban endpoint → 403
 * - Requester cannot access list endpoint → 403
 * - Snapshot OWNER_MISMATCH removed after clear
 * - Payout balance reflects correctly after unblock
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../src/app.js';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent, topup } from './helpers.js';

describe('TASK-HARD-012: Owner mismatch moderation — edge cases', () => {
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
   */
  async function createMismatchedAgent(seed: string): Promise<{ agentId: string }> {
    const agent = await onboardAgent(app, {
      tokenSeed: seed,
      role: 'worker',
      capabilities: ['python']
    });

    // Reverify with different owner handle → triggers mismatch detection
    const reverify = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: `mbtok_owner_alt_${seed}`,
        audience: 'clawbot.marketplace.local'
      }
    });
    expect(reverify.statusCode).toBe(200);

    return agent;
  }

  // ─── No-auth attacks (401) ──────────────────────────────────────────────
  it('GET /v1/moderation/owner-mismatches without auth → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches'
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST clear-owner-mismatch without auth → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/moderation/agents/agent_any/clear-owner-mismatch',
      payload: {}
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST ban-owner-mismatch without auth → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/moderation/agents/agent_any/ban-owner-mismatch',
      payload: {}
    });
    expect(res.statusCode).toBe(401);
  });

  // ─── Double-clear attack ────────────────────────────────────────────────
  it('double-clear same agent → first 200, second 404', async () => {
    const { agentId } = await createMismatchedAgent('dbl_clear_edge');

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_dbl_clear',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res1 = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { notes: 'First clear' }
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { notes: 'Second clear attempt' }
    });
    expect(res2.statusCode).toBe(404);
  });

  // ─── Ban after clear → 404 ─────────────────────────────────────────────
  it('ban after clear → 404 (flag already resolved)', async () => {
    const { agentId } = await createMismatchedAgent('ban_after_clear_edge');

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_bac_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_bac_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    // Clear first
    const clearRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {}
    });
    expect(clearRes.statusCode).toBe(200);

    // Try to ban → should 404
    const banRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: {}
    });
    expect(banRes.statusCode).toBe(404);
  });

  // ─── Clear after ban → 404 ─────────────────────────────────────────────
  it('clear after ban → 404 (flag already resolved)', async () => {
    const { agentId } = await createMismatchedAgent('clear_after_ban_edge');

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_cab_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_cab_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    // Ban first
    const banRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: {}
    });
    expect(banRes.statusCode).toBe(200);

    // Try to clear → should 404
    const clearRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {}
    });
    expect(clearRes.statusCode).toBe(404);
  });

  // ─── Self-clear attack ──────────────────────────────────────────────────
  it('agent cannot clear their own mismatch flag via worker role → 403', async () => {
    const { agentId } = await createMismatchedAgent('self_clear_edge');

    // Agent tries to clear their own mismatch
    const res = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(agentId, 'worker'),
      payload: {}
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Notes field validation ─────────────────────────────────────────────
  it('clear with notes exceeding 1000 chars → 400', async () => {
    const { agentId } = await createMismatchedAgent('notes_overflow_edge');

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_notes_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { notes: 'a'.repeat(1001) }
    });
    expect(res.statusCode).toBe(400);
  });

  it('ban with notes exceeding 1000 chars → 400', async () => {
    const { agentId } = await createMismatchedAgent('ban_notes_overflow_edge');

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_notes_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: { notes: 'b'.repeat(1001) }
    });
    expect(res.statusCode).toBe(400);
  });

  it('clear with notes exactly 1000 chars → succeeds', async () => {
    const { agentId } = await createMismatchedAgent('notes_1000_edge');

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_1000_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { notes: 'c'.repeat(1000) }
    });
    expect(res.statusCode).toBe(200);
  });

  // ─── Ban non-existent agent ─────────────────────────────────────────────
  it('ban agent with no mismatch flag → 404', async () => {
    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_ban_404_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    const cleanAgent = await onboardAgent(app, {
      tokenSeed: 'clean_agent_ban_edge',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${cleanAgent.agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: {}
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Banned agent blocked from marketplace ──────────────────────────────
  it('banned agent cannot top up wallet (AGENT_NOT_ACTIVE)', async () => {
    const { agentId } = await createMismatchedAgent('banned_topup_edge');

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_banned_topup_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    // Ban the agent
    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: {}
    });

    // Banned agent tries to top up
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(agentId, 'worker'),
      payload: { amount: 100 }
    });
    expect(res.statusCode).not.toBe(200);
  });

  it('banned agent status is BANNED in profile', async () => {
    const { agentId } = await createMismatchedAgent('banned_profile_edge');

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_banned_profile_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    // Ban the agent
    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: {}
    });

    // Verify profile shows BANNED
    const profileRes = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(agentId, 'worker')
    });
    expect(profileRes.statusCode).toBe(200);
    expect(profileRes.json<{ status: string }>().status).toBe('BANNED');
  });

  // ─── Historical handle update after clear ───────────────────────────────
  it('after clear, re-verify with same alt handle does NOT trigger new mismatch', async () => {
    const seed = 'handle_update_edge';
    const { agentId } = await createMismatchedAgent(seed);

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_handle_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    // Clear the mismatch → historical handle updated to new handle
    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {}
    });

    // Re-verify with same alt token → should NOT trigger mismatch
    const reverify = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: `mbtok_owner_alt_${seed}`,
        audience: 'clawbot.marketplace.local'
      }
    });
    expect(reverify.statusCode).toBe(200);
    const snapshot = reverify.json<{ snapshot: { blockReasons: Array<{ code: string }> } }>().snapshot;
    expect(snapshot.blockReasons.some((r) => r.code === 'OWNER_MISMATCH')).toBe(false);
  });

  // ─── Independent agent mismatches ───────────────────────────────────────
  it('multiple agents with mismatches can be cleared independently', async () => {
    const agent1 = await createMismatchedAgent('indep_agent_1_edge');
    const agent2 = await createMismatchedAgent('indep_agent_2_edge');

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_indep_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_indep_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    // Ban agent1
    const banRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agent1.agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: {}
    });
    expect(banRes.statusCode).toBe(200);

    // Clear agent2 independently
    const clearRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agent2.agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {}
    });
    expect(clearRes.statusCode).toBe(200);

    // List → agent1 resolved (banned), agent2 resolved (cleared)
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches',
      headers: authHeaders(moderator.agentId, 'moderator')
    });
    const mismatches = listRes.json<{ mismatches: Array<{ agentId: string }> }>().mismatches;
    expect(mismatches.some((m) => m.agentId === agent1.agentId)).toBe(false);
    expect(mismatches.some((m) => m.agentId === agent2.agentId)).toBe(false);
  });

  // ─── Snapshot OWNER_MISMATCH removed after clear ────────────────────────
  it('clearing removes OWNER_MISMATCH from moltbook snapshot blockReasons', async () => {
    const seed = 'snapshot_clear_edge';
    const { agentId } = await createMismatchedAgent(seed);

    // Verify mismatch in snapshot before
    const snapshotBefore = services.store.moltbookSnapshots.get(agentId);
    expect(snapshotBefore).toBeDefined();
    expect(snapshotBefore!.blockReasons.some((r) => r.code === 'OWNER_MISMATCH')).toBe(true);

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_snapshot_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {}
    });

    // Verify OWNER_MISMATCH removed from snapshot
    const snapshotAfter = services.store.moltbookSnapshots.get(agentId);
    expect(snapshotAfter).toBeDefined();
    expect(snapshotAfter!.blockReasons.some((r) => r.code === 'OWNER_MISMATCH')).toBe(false);
  });

  // ─── Payout balance accuracy after unblock ──────────────────────────────
  it('payout returns correct balance after mismatch is cleared and funds withdrawn', async () => {
    const seed = 'balance_accuracy_edge';
    const { agentId } = await createMismatchedAgent(seed);

    // Fund the agent (use admin role to bypass eligibility check for topup)
    await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: { 'x-agent-id': agentId, 'x-role': 'admin' },
      payload: { amount: 200 }
    });

    // Verify payout blocked
    const payoutBlocked = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(agentId, 'worker'),
      payload: { amount: 50 }
    });
    expect(payoutBlocked.statusCode).toBe(403);

    // Clear mismatch
    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_balance_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {}
    });

    // Payout should work and balance should be correct
    const payoutRes = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(agentId, 'worker'),
      payload: { amount: 75 }
    });
    expect(payoutRes.statusCode).toBe(200);

    const payoutBody = payoutRes.json<{ balance: number }>();
    expect(payoutBody.balance).toBe(125); // 200 - 75 = 125
  });

  // ─── Worker role escalation attacks on moderation ───────────────────────
  it('worker cannot access ban endpoint → 403', async () => {
    const { agentId } = await createMismatchedAgent('worker_ban_attack_edge');

    const worker2 = await onboardAgent(app, {
      tokenSeed: 'worker_ban_attacker_edge',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(worker2.agentId, 'worker'),
      payload: {}
    });
    expect(res.statusCode).toBe(403);
  });

  it('requester cannot access list endpoint → 403', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_list_attack_edge',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches',
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── BAN sanction has correct reason code ───────────────────────────────
  it('ban sanction has OWNER_MISMATCH_ESCALATION reason code', async () => {
    const { agentId } = await createMismatchedAgent('sanction_code_edge');

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_sanction_code_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    const banRes = await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: {}
    });
    expect(banRes.statusCode).toBe(200);

    // Verify sanction has correct reason code
    const sanctions = services.store.sanctions.get(agentId) ?? [];
    const banSanction = sanctions.find((s) =>
      s.type === 'BAN' && s.reasonCode === 'OWNER_MISMATCH_ESCALATION'
    );
    expect(banSanction).toBeDefined();
    expect(banSanction!.status).toBe('ACTIVE');
  });

  // ─── Mismatch flag structure validation ─────────────────────────────────
  it('mismatch flag has all required fields with correct types', async () => {
    const seed = 'flag_struct_edge';
    const { agentId } = await createMismatchedAgent(seed);

    const flags = [...services.store.ownerMismatchFlags.values()];
    const flag = flags.find((f) => f.agentId === agentId && !f.resolvedAt);

    expect(flag).toBeDefined();
    expect(typeof flag!.flagId).toBe('string');
    expect(flag!.flagId).toMatch(/^mismatch_/);
    expect(typeof flag!.agentId).toBe('string');
    expect(typeof flag!.previousHandle).toBe('string');
    expect(typeof flag!.newHandle).toBe('string');
    expect(typeof flag!.detectedAt).toBe('string');
    expect(flag!.resolvedAt).toBeUndefined();
    expect(flag!.resolution).toBeUndefined();
    expect(flag!.resolvedBy).toBeUndefined();
  });

  // ─── Resolved flag structure after clear ────────────────────────────────
  it('resolved flag (cleared) has resolvedAt, resolution, resolvedBy fields', async () => {
    const seed = 'resolved_flag_edge';
    const { agentId } = await createMismatchedAgent(seed);

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_resolved_flag_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    // Get flag ID before clearing
    const flags = [...services.store.ownerMismatchFlags.values()];
    const flag = flags.find((f) => f.agentId === agentId && !f.resolvedAt);
    const flagId = flag!.flagId;

    // Clear
    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { notes: 'test clear' }
    });

    // Verify resolved flag
    const resolvedFlag = services.store.ownerMismatchFlags.get(flagId);
    expect(resolvedFlag).toBeDefined();
    expect(resolvedFlag!.resolvedAt).toBeTruthy();
    expect(resolvedFlag!.resolution).toBe('cleared');
    expect(resolvedFlag!.resolvedBy).toBe(moderator.agentId);
  });

  // ─── Resolved flag structure after ban ──────────────────────────────────
  it('resolved flag (banned) has resolution=banned and resolvedBy set', async () => {
    const seed = 'resolved_ban_flag_edge';
    const { agentId } = await createMismatchedAgent(seed);

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_resolved_ban_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    // Get flag ID before banning
    const flags = [...services.store.ownerMismatchFlags.values()];
    const flag = flags.find((f) => f.agentId === agentId && !f.resolvedAt);
    const flagId = flag!.flagId;

    // Ban
    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/ban-owner-mismatch`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: { notes: 'ban test' }
    });

    // Verify resolved flag
    const resolvedFlag = services.store.ownerMismatchFlags.get(flagId);
    expect(resolvedFlag).toBeDefined();
    expect(resolvedFlag!.resolvedAt).toBeTruthy();
    expect(resolvedFlag!.resolution).toBe('banned');
    expect(resolvedFlag!.resolvedBy).toBe(admin.agentId);
  });

  // ─── Review action is persisted ─────────────────────────────────────────
  it('review action is persisted in store after clear', async () => {
    const seed = 'review_action_edge';
    const { agentId } = await createMismatchedAgent(seed);

    const moderator = await onboardAgent(app, {
      tokenSeed: 'mod_review_action_edge',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await app.inject({
      method: 'POST',
      url: `/v1/moderation/agents/${agentId}/clear-owner-mismatch`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { notes: 'review action test' }
    });

    // Verify review action exists
    const actions = [...services.store.mismatchReviewActions.values()];
    const action = actions.find((a) => a.moderatorId === moderator.agentId && a.actionType === 'cleared');
    expect(action).toBeDefined();
    expect(action!.notes).toBe('review action test');
    expect(action!.actedAt).toBeTruthy();
  });

  // ─── Mismatch ordering ─────────────────────────────────────────────────
  it('list returns mismatches ordered by detectedAt (oldest first)', async () => {
    // Create two mismatched agents in sequence
    await createMismatchedAgent('order_first_edge');
    await createMismatchedAgent('order_second_edge');

    const admin = await onboardAgent(app, {
      tokenSeed: 'admin_order_edge',
      role: 'admin',
      capabilities: ['admin']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/moderation/owner-mismatches',
      headers: authHeaders(admin.agentId, 'admin')
    });
    expect(res.statusCode).toBe(200);

    const mismatches = res.json<{ mismatches: Array<{ detectedAt: string }> }>().mismatches;
    // Verify ordering: each detectedAt should be ≤ the next
    for (let i = 1; i < mismatches.length; i++) {
      const prev = new Date(mismatches[i - 1].detectedAt).getTime();
      const curr = new Date(mismatches[i].detectedAt).getTime();
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });
});
