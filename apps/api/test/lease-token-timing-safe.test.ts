import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

describe('BUG-MED-001: timing-safe lease token verification', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  async function setupReservedTask() {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_ts',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_ts',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 200);

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
    const lease = reserve.json<{ leaseId: string; leaseToken: string; expiresAt: string }>();

    return { requester, worker, task, lease };
  }

  it('correct lease token is accepted on heartbeat', async () => {
    const { worker, task, lease } = await setupReservedTask();

    const heartbeat = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: lease.leaseToken
      }
    });

    expect(heartbeat.statusCode).toBe(200);
    const body = heartbeat.json<{ expiresAt: string }>();
    expect(body.expiresAt).toBeTruthy();
  });

  it('wrong lease token of same length is rejected with 401', async () => {
    const { worker, task, lease } = await setupReservedTask();

    // Construct a wrong token with the same length as the real token
    const wrongToken = lease.leaseToken.replace(/./g, (ch) =>
      ch === 'a' ? 'b' : 'a'
    );
    expect(wrongToken.length).toBe(lease.leaseToken.length);
    expect(wrongToken).not.toBe(lease.leaseToken);

    const heartbeat = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: wrongToken
      }
    });

    expect(heartbeat.statusCode).toBe(401);
    expect(heartbeat.json<{ error: { code: string } }>().error.code).toBe('LEASE_TOKEN_INVALID');
  });

  it('wrong lease token of different length is rejected with 401', async () => {
    const { worker, task, lease } = await setupReservedTask();

    // Short token — different length than UUID-format lease token
    const heartbeat = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: 'short'
      }
    });

    expect(heartbeat.statusCode).toBe(401);
    expect(heartbeat.json<{ error: { code: string } }>().error.code).toBe('LEASE_TOKEN_INVALID');
  });

  it('empty string lease token is rejected', async () => {
    const { worker, task, lease } = await setupReservedTask();

    const heartbeat = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: ''
      }
    });

    // Empty string may be rejected by Zod validation (400) or lease token check (401)
    expect([400, 401]).toContain(heartbeat.statusCode);
  });

  it('correct lease token is accepted on task accept', async () => {
    const { requester, task, lease } = await setupReservedTask();

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: lease.leaseToken
      }
    });

    expect(accept.statusCode).toBe(200);
    const contract = accept.json<{ contractId: string }>();
    expect(contract.contractId).toBeTruthy();
  });

  it('wrong lease token is rejected on task accept with 401', async () => {
    const { requester, task, lease } = await setupReservedTask();

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: 'forged-token-attempt'
      }
    });

    expect(accept.statusCode).toBe(401);
    expect(accept.json<{ error: { code: string } }>().error.code).toBe('LEASE_TOKEN_INVALID');
  });
});
