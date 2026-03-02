/**
 * TASK-HARD-006: Comprehensive escrow operation tests
 * - Escrow lock on contract creation
 * - Escrow release on milestone acceptance
 * - Slashing on dispute resolution
 * - Double-spend prevention
 * - Concurrent topup + payout
 * - Balance never goes negative
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

async function createAssignedContract(
  app: FastifyInstance,
  requesterId: string,
  workerId: string
): Promise<{ contractId: string; milestones: Array<{ milestoneId: string; amountCredits: number }> }> {
  const task = await createPostedTask(app, requesterId, 'python');

  const bid = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 100 }
  });
  if (bid.statusCode !== 200) throw new Error(`bid failed: ${bid.body}`);

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/reserve`,
    headers: authHeaders(workerId, 'worker')
  });
  if (reserve.statusCode !== 200) throw new Error(`reserve failed: ${reserve.body}`);

  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  const accept = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });
  if (accept.statusCode !== 200) throw new Error(`accept failed: ${accept.body}`);

  return accept.json<{ contractId: string; milestones: Array<{ milestoneId: string; amountCredits: number }> }>();
}

async function deliverMilestone(
  app: FastifyInstance,
  contractId: string,
  milestoneId: string,
  workerId: string,
  content: string
): Promise<void> {
  const sig = await app.inject({
    method: 'POST',
    url: `/v1/contracts/${contractId}/signature-preview`,
    headers: authHeaders(workerId, 'worker'),
    payload: { milestoneId, content }
  });
  if (sig.statusCode !== 200) throw new Error(`sig failed: ${sig.body}`);
  const { signature } = sig.json<{ signature: string }>();

  const deliver = await app.inject({
    method: 'POST',
    url: `/v1/contracts/${contractId}/deliver`,
    headers: authHeaders(workerId, 'worker'),
    payload: { milestoneId, content, signature }
  });
  if (deliver.statusCode !== 200) throw new Error(`deliver failed: ${deliver.body}`);
}

describe('TASK-HARD-006: escrow operations', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('locks requester funds in escrow when contract is created', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_escrow_lock',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_escrow_lock',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 200);

    const balBefore = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(balBefore.json<{ balance: number }>().balance).toBe(200);

    await createAssignedContract(app, requester.agentId, worker.agentId);

    // Budget was 100, so requester now has 200 - 100 = 100
    const balAfter = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(balAfter.json<{ balance: number }>().balance).toBe(100);
  });

  it('releases escrow to worker on milestone acceptance', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_escrow_release',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_escrow_release',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    const workerBalBefore = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(workerBalBefore.json<{ balance: number }>().balance).toBe(0);

    const milestone1 = contract.milestones[0];
    await deliverMilestone(app, contract.contractId, milestone1.milestoneId, worker.agentId, 'artifact-content-1');

    const accept1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: milestone1.milestoneId }
    });
    expect(accept1.statusCode).toBe(200);

    const workerBalAfterM1 = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(workerBalAfterM1.json<{ balance: number }>().balance).toBe(milestone1.amountCredits);

    const milestone2 = contract.milestones[1];
    await deliverMilestone(app, contract.contractId, milestone2.milestoneId, worker.agentId, 'artifact-content-2');

    const accept2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: milestone2.milestoneId }
    });
    expect(accept2.statusCode).toBe(200);

    const workerFinal = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(workerFinal.json<{ balance: number }>().balance).toBe(100);

    const requesterFinal = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(requesterFinal.json<{ balance: number }>().balance).toBe(0);
  });

  it('slashes requester balance when worker wins dispute (ruling=pay_worker)', async () => {
    // Requester tops up 200, creates a 100-budget contract → 100 remaining balance.
    // Worker disputes; moderator rules pay_worker and targets requester for slashing.
    // Expected: worker receives 100 from escrow; requester's remaining 100 is slashed 20% = 20,
    // leaving requester with 80.
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_slash_pw',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_slash_pw',
      role: 'worker',
      capabilities: ['python']
    });

    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_slash_pw',
      role: 'moderator',
      capabilities: ['moderation']
    });

    // Requester tops up 200 so they have 100 remaining after the 100-budget escrow lock
    await topup(app, requester.agentId, 'requester', 200);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    // Verify requester has 100 remaining after escrow lock
    const requesterAfterLock = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester.agentId, 'requester')
    });
    const requesterBalBeforeDispute = requesterAfterLock.json<{ balance: number }>().balance;
    expect(requesterBalBeforeDispute).toBe(100);

    const open = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'REQUESTER_FRAUD',
        againstAgentId: requester.agentId
      }
    });
    expect(open.statusCode).toBe(200);
    const dispute = open.json<{ disputeId: string }>();

    const resolve = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${dispute.disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'pay_worker',
        targetAgentId: requester.agentId
      }
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json<{ finalRuling: string }>().finalRuling).toBe('pay_worker');

    // Worker receives the full 100 escrow
    const workerBal = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(workerBal.json<{ balance: number }>().balance).toBe(100);

    // Requester's remaining 100 gets slashed 20% = 20 → left with 80
    const expectedSlash = Number((requesterBalBeforeDispute * 0.2).toFixed(2)); // 20
    const requesterFinal = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(requesterFinal.json<{ balance: number }>().balance).toBe(
      Number((requesterBalBeforeDispute - expectedSlash).toFixed(2))
    );
  });

  it('pays worker the full escrow on ruling=pay_worker (requester refund ruling)', async () => {
    // Worker has 0 balance (workers cannot topup directly).
    // After pay_worker ruling, worker should receive the full escrow amount.
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_pay_worker_b',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_pay_worker_b',
      role: 'worker',
      capabilities: ['python']
    });

    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_pay_worker_b',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    const open = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'REQUESTER_FRAUD',
        againstAgentId: requester.agentId
      }
    });
    expect(open.statusCode).toBe(200);
    const dispute = open.json<{ disputeId: string }>();

    const resolve = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${dispute.disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'pay_worker',
        targetAgentId: requester.agentId
      }
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json<{ finalRuling: string }>().finalRuling).toBe('pay_worker');

    // Worker gets the full escrow (100). Workers start with 0 balance.
    const workerBal = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(workerBal.json<{ balance: number }>().balance).toBe(100);
  });

  it('prevents double-spend: cannot accept task without sufficient funds', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_double_spend',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_double_spend',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 5
    });

    // Requester has only 80 but task budget is 100
    await topup(app, requester.agentId, 'requester', 80);

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 }
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(reserve.statusCode).toBe(200);
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });

    expect(accept.statusCode).toBe(409);
    expect(accept.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('all balances remain non-negative after partial delivery and dispute', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_nonneg',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_nonneg',
      role: 'worker',
      capabilities: ['python']
    });

    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_nonneg',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    // Deliver and accept milestone 1
    const ms1 = contract.milestones[0];
    await deliverMilestone(app, contract.contractId, ms1.milestoneId, worker.agentId, 'partial-1');
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: ms1.milestoneId }
    });

    // Dispute remaining escrow
    const open = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'PARTIAL',
        againstAgentId: worker.agentId
      }
    });
    const dispute = open.json<{ disputeId: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/disputes/${dispute.disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'refund_requester', targetAgentId: worker.agentId }
    });

    const reqBal = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester.agentId, 'requester')
    });
    const wrkBal = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reqBal.json<{ balance: number }>().balance).toBeGreaterThanOrEqual(0);
    expect(wrkBal.json<{ balance: number }>().balance).toBeGreaterThanOrEqual(0);
  });

  it('topup increases balance correctly with multiple topups', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_topup_multi',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const bal0 = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(bal0.json<{ balance: number }>().balance).toBe(0);

    const t1 = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { amount: 250 }
    });
    expect(t1.statusCode).toBe(200);
    expect(t1.json<{ balance: number }>().balance).toBe(250);

    const t2 = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { amount: 75 }
    });
    expect(t2.statusCode).toBe(200);
    expect(t2.json<{ balance: number }>().balance).toBe(325);
  });

  it('milestone amount precision is maintained (no floating-point drift)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_precision',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_precision',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    const totalMilestoneAmount = contract.milestones.reduce((sum, m) => sum + m.amountCredits, 0);
    expect(Number(totalMilestoneAmount.toFixed(2))).toBe(100);
  });

  it('splits escrow funds between both parties on ruling=split', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_split',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_split',
      role: 'worker',
      capabilities: ['python']
    });

    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_split',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    const open = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'PARTIAL_DELIVERY',
        againstAgentId: worker.agentId
      }
    });
    expect(open.statusCode).toBe(200);
    const dispute = open.json<{ disputeId: string }>();

    const resolve = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${dispute.disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'split',
        targetAgentId: worker.agentId
      }
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json<{ finalRuling: string }>().finalRuling).toBe('split');

    const reqBal = (await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester.agentId, 'requester')
    })).json<{ balance: number }>().balance;

    const wrkBal = (await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    })).json<{ balance: number }>().balance;

    // Both get approximately half (50 each), worker may be slashed
    expect(reqBal).toBeGreaterThanOrEqual(49);
    expect(wrkBal).toBeGreaterThanOrEqual(0);
    // Combined from escrow is 100, worker slash comes from their balance (which is 0)
    expect(reqBal + wrkBal).toBeLessThanOrEqual(100);
  });
});
