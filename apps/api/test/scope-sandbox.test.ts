import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

describe('scope sandbox and least privilege enforcement', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns only scope manifest to lease owner and blocks other workers', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_scope',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_scope',
      role: 'worker',
      capabilities: ['python']
    });

    const rival = await onboardAgent(app, {
      tokenSeed: 'worker_rival',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

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

    const scopeWorker = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/scope?leaseId=${lease.leaseId}&leaseToken=${lease.leaseToken}`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(scopeWorker.statusCode).toBe(200);
    const scopeBody = scopeWorker.json<{
      allowedDataRefs: string[];
      allowedTools: string[];
      egressAllowlist: string[];
      deliverableSchemaRef: string;
      acceptanceTestsRef: string;
    }>();

    expect(scopeBody.allowedDataRefs).toEqual(['dataset://tenant-a/input.csv']);
    expect(scopeBody.allowedTools).toEqual(['python']);
    expect(Object.keys(scopeBody).includes('title')).toBe(false);
    expect(Object.keys(scopeBody).includes('description')).toBe(false);

    const scopeRival = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/scope?leaseId=${lease.leaseId}&leaseToken=${lease.leaseToken}`,
      headers: authHeaders(rival.agentId, 'worker')
    });

    expect(scopeRival.statusCode).toBe(403);
    expect(scopeRival.json<{ error: { code: string } }>().error.code).toBe('SCOPE_FORBIDDEN');

    const scopeRequester = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/scope?leaseId=${lease.leaseId}&leaseToken=${lease.leaseToken}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(scopeRequester.statusCode).toBe(200);

    const badToken = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/scope?leaseId=${lease.leaseId}&leaseToken=wrong-token`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(badToken.statusCode).toBe(401);
  });

  it('keeps public listings minimal and excludes sensitive fields', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_public',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    await createPostedTask(app, requester.agentId, 'python');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/tasks/public'
    });

    expect(list.statusCode).toBe(200);

    const payload = list.json<{ tasks: Array<Record<string, unknown>> }>();
    expect(payload.tasks.length).toBeGreaterThan(0);

    const task = payload.tasks[0];
    expect(task.description).toBeUndefined();
    expect(task.scopeManifestId).toBeUndefined();
    expect(task.title).toBeTypeOf('string');
    expect(task.budget).toBeTypeOf('number');
  });
});
