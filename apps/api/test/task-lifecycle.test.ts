import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

async function createAssignedContract(app: FastifyInstance, requesterId: string, workerId: string): Promise<{ contractId: string; milestoneId: string }> {
  const task = await createPostedTask(app, requesterId, 'python');

  await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 100 }
  });

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/reserve`,
    headers: authHeaders(workerId, 'worker')
  });

  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();
  const acceptTask = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });

  const contract = acceptTask.json<{ contractId: string; milestones: { milestoneId: string }[] }>();
  return { contractId: contract.contractId, milestoneId: contract.milestones[0].milestoneId };
}

describe('task lifecycle and escrow settlement', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('executes posting, matching, contract, delivery, and settlement', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_main',
      role: 'requester',
      capabilities: ['orchestrator'],
      maxConcurrency: 3
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_main',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 2
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    const bid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 }
    });
    expect(bid.statusCode).toBe(200);

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(reserve.statusCode).toBe(200);

    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const acceptTask = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });

    expect(acceptTask.statusCode).toBe(200);
    const contract = acceptTask.json<{ contractId: string; milestones: { milestoneId: string }[] }>();

    const milestone1 = contract.milestones[0].milestoneId;
    const milestone2 = contract.milestones[1].milestoneId;

    const sig1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: milestone1,
        content: 'artifact-1'
      }
    });

    expect(sig1.statusCode).toBe(200);
    const signature1 = sig1.json<{ signature: string }>().signature;

    const deliver1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: milestone1,
        content: 'artifact-1',
        signature: signature1
      }
    });

    expect(deliver1.statusCode).toBe(200);

    const accept1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        milestoneId: milestone1
      }
    });

    expect(accept1.statusCode).toBe(200);

    const sig2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: milestone2,
        content: 'artifact-2'
      }
    });

    expect(sig2.statusCode).toBe(200);
    const signature2 = sig2.json<{ signature: string }>().signature;

    const deliver2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: milestone2,
        content: 'artifact-2',
        signature: signature2
      }
    });

    expect(deliver2.statusCode).toBe(200);

    const accept2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        milestoneId: milestone2
      }
    });

    expect(accept2.statusCode).toBe(200);

    const requesterLedger = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(requesterLedger.statusCode).toBe(200);
    expect(requesterLedger.json<{ balance: number }>().balance).toBe(0);

    const workerLedger = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(workerLedger.statusCode).toBe(200);
    expect(workerLedger.json<{ balance: number }>().balance).toBe(100);

    const taskState = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(taskState.statusCode).toBe(200);
    expect(taskState.json<{ status: string }>().status).toBe('ACCEPTED');
  });

  it('enforces worker concurrency limits during reservation', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_conc',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_conc',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 1
    });

    await topup(app, requester.agentId, 'requester', 250);

    const task1 = await createPostedTask(app, requester.agentId, 'python');
    const task2 = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task1.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 90 }
    });

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task2.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 90 }
    });

    const reserve1 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task1.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reserve1.statusCode).toBe(200);

    const reserve2 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task2.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reserve2.statusCode).toBe(409);
    expect(reserve2.json<{ error: { code: string } }>().error.code).toBe('WORKER_CAPACITY_EXCEEDED');
  });

  it('rejects milestone delivery with invalid artifact signature', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_sig',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_sig',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const assigned = await createAssignedContract(app, requester.agentId, worker.agentId);
    const deliver = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${assigned.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: assigned.milestoneId,
        content: 'malicious-payload',
        signature: 'bad-signature'
      }
    });

    expect(deliver.statusCode).toBe(400);
    expect(deliver.json<{ error: { code: string } }>().error.code).toBe('INVALID_ARTIFACT_SIGNATURE');
  });
});
