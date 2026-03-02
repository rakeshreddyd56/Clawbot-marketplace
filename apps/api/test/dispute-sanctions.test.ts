import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

async function createAssignedContract(app: FastifyInstance, requesterId: string, workerId: string): Promise<{ contractId: string }> {
  const task = await createPostedTask(app, requesterId, 'python');

  const bid = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 80 }
  });

  if (bid.statusCode !== 200) {
    throw new Error(`bid failed: ${bid.statusCode} ${bid.body}`);
  }

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/reserve`,
    headers: authHeaders(workerId, 'worker')
  });

  if (reserve.statusCode !== 200) {
    throw new Error(`reserve failed: ${reserve.statusCode} ${reserve.body}`);
  }

  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  const accept = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });

  if (accept.statusCode !== 200) {
    throw new Error(`accept failed: ${accept.statusCode} ${accept.body}`);
  }

  return accept.json<{ contractId: string }>();
}

describe('dispute and sanctions enforcement', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('supports dispute appeal and escalates sanctions to blacklist', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_dispute',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_dispute',
      role: 'worker',
      capabilities: ['python']
    });

    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_dispute',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await topup(app, requester.agentId, 'requester', 200);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    const open1 = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'NON_DELIVERY',
        againstAgentId: worker.agentId
      }
    });

    expect(open1.statusCode).toBe(200);
    const dispute1 = open1.json<{ disputeId: string; status: string }>();
    expect(dispute1.status).toBe('AUTO_DECIDED');

    const appeal = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${dispute1.disputeId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(appeal.statusCode).toBe(200);
    expect(appeal.json<{ status: string }>().status).toBe('UNDER_APPEAL');

    const resolve1 = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${dispute1.disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'refund_requester',
        targetAgentId: worker.agentId
      }
    });

    expect(resolve1.statusCode).toBe(200);
    expect(resolve1.json<{ status: string; finalRuling: string }>().status).toBe('FINAL');

    const open2 = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'BREACH_REPEAT',
        againstAgentId: worker.agentId
      }
    });

    expect(open2.statusCode).toBe(200);
    const dispute2 = open2.json<{ disputeId: string }>();

    const resolve2 = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${dispute2.disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'split',
        targetAgentId: worker.agentId
      }
    });

    expect(resolve2.statusCode).toBe(200);

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

    const me = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(me.statusCode).toBe(200);
    expect(me.json<{ status: string }>().status).toBe('BANNED');

    const nextTask = await createPostedTask(app, requester.agentId, 'python');
    const bannedBid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${nextTask.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 70 }
    });

    expect(bannedBid.statusCode).toBe(403);
    expect(bannedBid.json<{ error: { code: string } }>().error.code).toBe('WORKER_BID_BLOCKED');
  });
});
