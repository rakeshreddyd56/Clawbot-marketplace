/**
 * E2E + Regression Tests: Dispute Response Deadline (72h Auto-Ruling)
 *
 * TASK-ENFORCE-004: When a dispute goes unresponded for 72 hours,
 * the system must automatically rule in favor of the dispute opener.
 *
 * Test categories:
 * 1. Happy path: auto-ruling fires after 72h expiry
 * 2. Appeal within window prevents auto-ruling
 * 3. Edge cases: boundary timing, multiple disputes, already-resolved
 * 4. Escrow handling: funds released correctly on auto-ruling
 * 5. Sanctions: progressive sanctions applied on auto-ruling
 * 6. Audit trail: events emitted for auto-ruling
 * 7. Access control: only admins can trigger sweep
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../src/app.js';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAssignedContract(
  app: FastifyInstance,
  requesterId: string,
  workerId: string
): Promise<{ contractId: string; taskId: string }> {
  const task = await createPostedTask(app, requesterId, 'python');

  const bid = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 80 }
  });
  if (bid.statusCode !== 200) throw new Error(`bid failed: ${bid.statusCode} ${bid.body}`);

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/reserve`,
    headers: authHeaders(workerId, 'worker')
  });
  if (reserve.statusCode !== 200) throw new Error(`reserve failed: ${reserve.statusCode} ${reserve.body}`);

  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  const accept = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });
  if (accept.statusCode !== 200) throw new Error(`accept failed: ${accept.statusCode} ${accept.body}`);

  const contract = accept.json<{ contractId: string }>();
  return { contractId: contract.contractId, taskId: task.taskId };
}

async function openDispute(
  app: FastifyInstance,
  actorId: string,
  actorRole: 'requester' | 'worker',
  contractId: string,
  againstAgentId: string,
  reasonCode = 'NON_DELIVERY'
): Promise<{ disputeId: string; status: string; appealDeadlineAt: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/disputes',
    headers: authHeaders(actorId, actorRole),
    payload: { contractId, reasonCode, againstAgentId }
  });
  if (res.statusCode !== 200) throw new Error(`open dispute failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

function expireDisputeDeadline(services: AppServices, disputeId: string, hoursAgo = 1): void {
  const dispute = services.store.disputes.get(disputeId)!;
  const expired = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  services.store.disputes.set(disputeId, {
    ...dispute,
    appealDeadlineAt: expired,
    responseDeadlineAt: expired
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispute 72h auto-ruling (TASK-ENFORCE-004)', () => {
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

  // =========================================================================
  // 1. Happy path: expired disputes are auto-ruled
  // =========================================================================

  describe('happy path — auto-ruling on expired disputes', () => {
    it('auto-rules an expired dispute in favor of the opener (requester)', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_happy1',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_happy1',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_happy1',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

      // Open dispute by requester against worker
      const dispute = await openDispute(
        app, requester.agentId, 'requester', contractId, worker.agentId
      );
      expect(dispute.status).toBe('AUTO_DECIDED');

      // Expire the deadline (simulate 72h passing)
      expireDisputeDeadline(services, dispute.disputeId);

      // Trigger sweep
      const sweepRes = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      expect(sweepRes.statusCode).toBe(200);
      const sweepBody = sweepRes.json<{ swept: number; disputes: Array<{ disputeId: string; status: string; finalRuling: string }> }>();
      expect(sweepBody.swept).toBe(1);
      expect(sweepBody.disputes[0].disputeId).toBe(dispute.disputeId);
      expect(sweepBody.disputes[0].status).toBe('FINAL');
      expect(sweepBody.disputes[0].finalRuling).toBe('refund_requester');
    });

    it('auto-rules an expired dispute in favor of the opener (worker)', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_happy2',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_happy2',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_happy2',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

      // Open dispute by worker against requester
      const dispute = await openDispute(
        app, worker.agentId, 'worker', contractId, requester.agentId
      );
      expect(dispute.status).toBe('AUTO_DECIDED');

      expireDisputeDeadline(services, dispute.disputeId);

      const sweepRes = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      expect(sweepRes.statusCode).toBe(200);
      const sweepBody = sweepRes.json<{ swept: number; disputes: Array<{ finalRuling: string }> }>();
      expect(sweepBody.swept).toBe(1);
      // Worker opened → ruling should be pay_worker
      expect(sweepBody.disputes[0].finalRuling).toBe('pay_worker');
    });

    it('dispute is marked FINAL after auto-ruling', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_final',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_final',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_final',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);

      expireDisputeDeadline(services, dispute.disputeId);

      await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      // Verify via GET endpoint
      const getRes = await app.inject({
        method: 'GET',
        url: `/v1/disputes/${dispute.disputeId}`,
        headers: authHeaders(requester.agentId, 'requester')
      });

      expect(getRes.statusCode).toBe(200);
      const updatedDispute = getRes.json<{ status: string; finalRuling: string }>();
      expect(updatedDispute.status).toBe('FINAL');
      expect(updatedDispute.finalRuling).toBe('refund_requester');
    });
  });

  // =========================================================================
  // 2. Non-expired disputes are NOT auto-ruled
  // =========================================================================

  describe('non-expired disputes are skipped', () => {
    it('does not auto-rule disputes still within 72h window', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_nox1',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_nox1',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_adm_nox1',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);

      // Do NOT expire the deadline — sweep should find nothing
      const sweepRes = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      expect(sweepRes.statusCode).toBe(200);
      expect(sweepRes.json<{ swept: number }>().swept).toBe(0);
    });

    it('does not auto-rule disputes that were already appealed', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_apl1',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_apl1',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_adm_apl1',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);

      // Appeal the dispute (within window)
      const appealRes = await app.inject({
        method: 'POST',
        url: `/v1/disputes/${dispute.disputeId}/appeal`,
        headers: authHeaders(worker.agentId, 'worker')
      });
      expect(appealRes.statusCode).toBe(200);

      // Now expire the deadline and sweep
      expireDisputeDeadline(services, dispute.disputeId);

      const sweepRes = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      expect(sweepRes.statusCode).toBe(200);
      // Should NOT be swept because status is UNDER_APPEAL, not AUTO_DECIDED
      expect(sweepRes.json<{ swept: number }>().swept).toBe(0);
    });

    it('does not auto-rule disputes already resolved by moderator', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_res1',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_res1',
        role: 'worker',
        capabilities: ['python']
      });
      const moderator = await onboardAgent(app, {
        tokenSeed: 'ar_mod_resolved',
        role: 'moderator',
        capabilities: ['moderation']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_resolved',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);

      // Moderator resolves immediately
      const resolveRes = await app.inject({
        method: 'POST',
        url: `/v1/disputes/${dispute.disputeId}/resolve`,
        headers: authHeaders(moderator.agentId, 'moderator'),
        payload: { ruling: 'pay_worker', targetAgentId: worker.agentId }
      });
      expect(resolveRes.statusCode).toBe(200);

      // Expire and sweep
      expireDisputeDeadline(services, dispute.disputeId);

      const sweepRes = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      expect(sweepRes.statusCode).toBe(200);
      expect(sweepRes.json<{ swept: number }>().swept).toBe(0);
    });
  });

  // =========================================================================
  // 3. Escrow handling on auto-ruling
  // =========================================================================

  describe('escrow handling', () => {
    it('refunds requester escrow on auto-ruling when requester opened dispute', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_rq_esc1',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wk_esc1',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_adm_esc1',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);

      // Record balance before contract
      const walletBefore = await app.inject({
        method: 'GET',
        url: '/v1/wallet',
        headers: authHeaders(requester.agentId, 'requester')
      });
      const balanceBefore = walletBefore.json<{ balance: number }>().balance;

      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

      // Balance should have decreased (escrow locked)
      const walletAfterEscrow = await app.inject({
        method: 'GET',
        url: '/v1/wallet',
        headers: authHeaders(requester.agentId, 'requester')
      });
      const balanceAfterEscrow = walletAfterEscrow.json<{ balance: number }>().balance;
      expect(balanceAfterEscrow).toBeLessThan(balanceBefore);

      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);
      expireDisputeDeadline(services, dispute.disputeId);

      await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      // Requester should get escrow funds back
      const walletAfterRuling = await app.inject({
        method: 'GET',
        url: '/v1/wallet',
        headers: authHeaders(requester.agentId, 'requester')
      });
      const balanceAfterRuling = walletAfterRuling.json<{ balance: number }>().balance;
      expect(balanceAfterRuling).toBeGreaterThan(balanceAfterEscrow);
    });
  });

  // =========================================================================
  // 4. Sanctions applied on auto-ruling
  // =========================================================================

  describe('sanctions on auto-ruling', () => {
    it('applies SUSPEND sanction to non-responding party', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_rq_sn1',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wk_sn1',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_adm_sn1',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);
      expireDisputeDeadline(services, dispute.disputeId);

      await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      // Worker (non-responding party) should have a SUSPEND sanction
      const sanctions = await app.inject({
        method: 'GET',
        url: '/v1/agents/me/sanctions',
        headers: authHeaders(worker.agentId, 'worker')
      });

      expect(sanctions.statusCode).toBe(200);
      const sanctionList = sanctions.json<Array<{ type: string }>>();
      expect(sanctionList.length).toBeGreaterThanOrEqual(1);
      expect(sanctionList[0].type).toBe('SUSPEND');
    });

    it('escalates to BAN on second auto-ruled dispute', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_ban',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_ban',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_ban',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);

      // First dispute — auto-ruled → SUSPEND
      const { contractId: c1 } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const d1 = await openDispute(app, requester.agentId, 'requester', c1, worker.agentId);
      expireDisputeDeadline(services, d1.disputeId);

      await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      // Second dispute on same contract — auto-ruled → BAN
      const d2 = await openDispute(app, requester.agentId, 'requester', c1, worker.agentId, 'BREACH_REPEAT');
      expireDisputeDeadline(services, d2.disputeId);

      await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      const sanctions = await app.inject({
        method: 'GET',
        url: '/v1/agents/me/sanctions',
        headers: authHeaders(worker.agentId, 'worker')
      });

      expect(sanctions.statusCode).toBe(200);
      const sanctionList = sanctions.json<Array<{ type: string }>>();
      expect(sanctionList.length).toBe(2);
      expect(sanctionList[0].type).toBe('SUSPEND');
      expect(sanctionList[1].type).toBe('BAN');
    });
  });

  // =========================================================================
  // 5. Multiple disputes swept at once
  // =========================================================================

  describe('batch sweep', () => {
    it('sweeps multiple expired disputes in a single call', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_batch',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker1 = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_batch1',
        role: 'worker',
        capabilities: ['python']
      });
      const worker2 = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_batch2',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_batch',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 1000);

      const { contractId: c1 } = await createAssignedContract(app, requester.agentId, worker1.agentId);
      const { contractId: c2 } = await createAssignedContract(app, requester.agentId, worker2.agentId);

      const d1 = await openDispute(app, requester.agentId, 'requester', c1, worker1.agentId);
      const d2 = await openDispute(app, requester.agentId, 'requester', c2, worker2.agentId);

      expireDisputeDeadline(services, d1.disputeId);
      expireDisputeDeadline(services, d2.disputeId);

      const sweepRes = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      expect(sweepRes.statusCode).toBe(200);
      expect(sweepRes.json<{ swept: number }>().swept).toBe(2);
    });

    it('sweeps only expired disputes, leaving non-expired ones', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_mixed',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker1 = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_mixed1',
        role: 'worker',
        capabilities: ['python']
      });
      const worker2 = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_mixed2',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_mixed',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 1000);

      const { contractId: c1 } = await createAssignedContract(app, requester.agentId, worker1.agentId);
      const { contractId: c2 } = await createAssignedContract(app, requester.agentId, worker2.agentId);

      const d1 = await openDispute(app, requester.agentId, 'requester', c1, worker1.agentId);
      const d2 = await openDispute(app, requester.agentId, 'requester', c2, worker2.agentId);

      // Only expire d1
      expireDisputeDeadline(services, d1.disputeId);

      const sweepRes = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      expect(sweepRes.statusCode).toBe(200);
      expect(sweepRes.json<{ swept: number }>().swept).toBe(1);

      // d2 should still be AUTO_DECIDED
      const d2Check = await app.inject({
        method: 'GET',
        url: `/v1/disputes/${d2.disputeId}`,
        headers: authHeaders(requester.agentId, 'requester')
      });
      expect(d2Check.json<{ status: string }>().status).toBe('AUTO_DECIDED');
    });
  });

  // =========================================================================
  // 6. Access control for sweep endpoint
  // =========================================================================

  describe('access control', () => {
    it('non-admin cannot trigger sweep', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_acl',
        role: 'requester',
        capabilities: ['orchestrator']
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(requester.agentId, 'requester')
      });

      expect(res.statusCode).toBe(403);
    });

    it('worker cannot trigger sweep', async () => {
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_acl',
        role: 'worker',
        capabilities: ['python']
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(worker.agentId, 'worker')
      });

      expect(res.statusCode).toBe(403);
    });

    it('moderator cannot trigger sweep', async () => {
      const moderator = await onboardAgent(app, {
        tokenSeed: 'ar_mod_acl',
        role: 'moderator',
        capabilities: ['moderation']
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(moderator.agentId, 'moderator')
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // 7. Idempotency — sweep same dispute twice
  // =========================================================================

  describe('idempotency', () => {
    it('second sweep does not re-process already-ruled disputes', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_rq_idem',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wk_idem',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_adm_idem',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);
      expireDisputeDeadline(services, dispute.disputeId);

      // First sweep
      const sweep1 = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });
      expect(sweep1.json<{ swept: number }>().swept).toBe(1);

      // Second sweep — should find nothing
      const sweep2 = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });
      expect(sweep2.json<{ swept: number }>().swept).toBe(0);
    });
  });

  // =========================================================================
  // 8. Task status transition on auto-ruling
  // =========================================================================

  describe('task status transitions', () => {
    it('task transitions to RESOLVED after auto-ruling', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_rq_ts',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wk_ts',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_adm_ts',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId, taskId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);

      // After dispute opened, task should be DISPUTED
      const taskBeforeSweep = services.store.tasks.get(taskId);
      expect(taskBeforeSweep?.status).toBe('DISPUTED');

      expireDisputeDeadline(services, dispute.disputeId);

      await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      // After auto-ruling, task should be RESOLVED
      const taskAfterSweep = services.store.tasks.get(taskId);
      expect(taskAfterSweep?.status).toBe('RESOLVED');
    });
  });

  // =========================================================================
  // 9. Audit events emitted for auto-ruling
  // =========================================================================

  describe('audit trail', () => {
    it('emits dispute.auto_ruled audit event', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_req_audit',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wrk_audit',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_audit',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);
      expireDisputeDeadline(services, dispute.disputeId);

      await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      // Check audit events for the dispute
      const events = services.marketplace.listEvents(dispute.disputeId);
      const autoRuledEvent = events.find(e => e.eventType === 'dispute.auto_ruled');
      expect(autoRuledEvent).toBeDefined();
      expect(autoRuledEvent!.payload).toMatchObject({
        ruling: 'refund_requester',
        reason: 'RESPONSE_TIMEOUT'
      });
    });

    it('generates evidence pack on auto-ruling', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_rq_evid',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wk_evid',
        role: 'worker',
        capabilities: ['python']
      });
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_adm_evid',
        role: 'admin',
        capabilities: ['admin']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);
      expireDisputeDeadline(services, dispute.disputeId);

      await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      // Check evidence pack was created
      const evidencePack = [...services.store.evidencePacks.values()].find(
        ep => ep.disputeId === dispute.disputeId
      );
      expect(evidencePack).toBeDefined();
      expect(evidencePack!.contractId).toBe(contractId);
    });
  });

  // =========================================================================
  // 10. Edge case: appeal at exact boundary
  // =========================================================================

  describe('edge cases', () => {
    it('appeal succeeds at exactly the deadline (not expired yet)', async () => {
      const requester = await onboardAgent(app, {
        tokenSeed: 'ar_rq_bnd',
        role: 'requester',
        capabilities: ['orchestrator']
      });
      const worker = await onboardAgent(app, {
        tokenSeed: 'ar_wk_bnd',
        role: 'worker',
        capabilities: ['python']
      });

      await topup(app, requester.agentId, 'requester', 500);
      const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
      const dispute = await openDispute(app, requester.agentId, 'requester', contractId, worker.agentId);

      // Set deadline to a few seconds from now (still valid)
      const d = services.store.disputes.get(dispute.disputeId)!;
      services.store.disputes.set(dispute.disputeId, {
        ...d,
        appealDeadlineAt: new Date(Date.now() + 5000).toISOString() // 5 seconds in future
      });

      const appealRes = await app.inject({
        method: 'POST',
        url: `/v1/disputes/${dispute.disputeId}/appeal`,
        headers: authHeaders(worker.agentId, 'worker')
      });

      expect(appealRes.statusCode).toBe(200);
      expect(appealRes.json<{ status: string }>().status).toBe('UNDER_APPEAL');
    });

    it('sweep returns empty array when no disputes exist', async () => {
      const admin = await onboardAgent(app, {
        tokenSeed: 'ar_admin_empty',
        role: 'admin',
        capabilities: ['admin']
      });

      const sweepRes = await app.inject({
        method: 'POST',
        url: '/v1/disputes/sweep',
        headers: authHeaders(admin.agentId, 'admin')
      });

      expect(sweepRes.statusCode).toBe(200);
      expect(sweepRes.json<{ swept: number; disputes: unknown[] }>().swept).toBe(0);
      expect(sweepRes.json<{ disputes: unknown[] }>().disputes).toEqual([]);
    });
  });
});
