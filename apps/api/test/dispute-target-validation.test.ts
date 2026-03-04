/**
 * BUG-HIGH-003: Moderator cannot slash/sanction arbitrary agents
 *
 * Tests that resolveDispute() validates the targetAgentId is actually
 * a party (requester or worker) to the dispute's contract, preventing
 * a moderator from slashing or sanctioning arbitrary unrelated agents.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../src/app.js';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

// -----------------------------------------------------------------------
// Local helper: creates a fully ASSIGNED contract (task accepted)
// -----------------------------------------------------------------------
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

// -----------------------------------------------------------------------
// Local helper: open a dispute and return disputeId
// -----------------------------------------------------------------------
async function openDispute(
  app: FastifyInstance,
  requesterId: string,
  contractId: string,
  againstAgentId: string
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/disputes',
    headers: authHeaders(requesterId, 'requester'),
    payload: {
      contractId,
      reasonCode: 'NON_DELIVERY',
      againstAgentId
    }
  });
  if (res.statusCode !== 200) throw new Error(`open dispute failed: ${res.statusCode} ${res.body}`);
  return res.json<{ disputeId: string }>().disputeId;
}

describe('BUG-HIGH-003: dispute target agent validation', () => {
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

  it('rejects resolve with targetAgentId not party to dispute contract', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'tv_req_nonparty',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'tv_wrk_nonparty',
      role: 'worker',
      capabilities: ['python']
    });
    const moderator = await onboardAgent(app, {
      tokenSeed: 'tv_mod_nonparty',
      role: 'moderator',
      capabilities: ['moderation']
    });
    // Innocent bystander agent who is NOT part of the contract
    const bystander = await onboardAgent(app, {
      tokenSeed: 'tv_bystander',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 200);

    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // Record bystander's balance before the attack attempt
    const balanceBefore = await app.inject({
      method: 'GET',
      url: '/v1/wallet',
      headers: authHeaders(bystander.agentId, 'worker')
    });
    const bystanderBalanceBefore = balanceBefore.json<{ balance: number }>().balance;

    // Moderator tries to slash the bystander — must be rejected
    const res = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'refund_requester',
        targetAgentId: bystander.agentId
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_TARGET_AGENT');

    // Verify bystander balance is unchanged — no slashing occurred
    const balanceAfter = await app.inject({
      method: 'GET',
      url: '/v1/wallet',
      headers: authHeaders(bystander.agentId, 'worker')
    });
    expect(balanceAfter.json<{ balance: number }>().balance).toBe(bystanderBalanceBefore);

    // Verify bystander has no sanctions
    const sanctions = await app.inject({
      method: 'GET',
      url: '/v1/agents/me/sanctions',
      headers: authHeaders(bystander.agentId, 'worker')
    });
    expect(sanctions.json<Array<unknown>>()).toHaveLength(0);

    // Verify bystander status is still ACTIVE (not SUSPENDED or BANNED)
    const profile = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(bystander.agentId, 'worker')
    });
    expect(profile.json<{ status: string }>().status).toBe('ACTIVE');
  });

  it('allows resolve when targetAgentId is the contract requester', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'tv_req_valid_requester',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'tv_wrk_valid_requester',
      role: 'worker',
      capabilities: ['python']
    });
    const moderator = await onboardAgent(app, {
      tokenSeed: 'tv_mod_valid_requester',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await topup(app, requester.agentId, 'requester', 200);

    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // Moderator sanctions the requester (a valid contract party)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'pay_worker',
        targetAgentId: requester.agentId
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string; finalRuling: string }>().status).toBe('FINAL');
    expect(res.json<{ finalRuling: string }>().finalRuling).toBe('pay_worker');
  });

  it('allows resolve when targetAgentId is the contract worker', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'tv_req_valid_worker',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'tv_wrk_valid_worker',
      role: 'worker',
      capabilities: ['python']
    });
    const moderator = await onboardAgent(app, {
      tokenSeed: 'tv_mod_valid_worker',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await topup(app, requester.agentId, 'requester', 200);

    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // Moderator sanctions the worker (a valid contract party)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'refund_requester',
        targetAgentId: worker.agentId
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string; finalRuling: string }>().status).toBe('FINAL');
    expect(res.json<{ finalRuling: string }>().finalRuling).toBe('refund_requester');
  });

  it('rejects targeting the moderator themselves as slash target', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'tv_req_selfslash',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'tv_wrk_selfslash',
      role: 'worker',
      capabilities: ['python']
    });
    const moderator = await onboardAgent(app, {
      tokenSeed: 'tv_mod_selfslash',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await topup(app, requester.agentId, 'requester', 200);

    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // Moderator tries to target themselves — they are not a contract party
    const res = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'split',
        targetAgentId: moderator.agentId
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_TARGET_AGENT');
  });
});
