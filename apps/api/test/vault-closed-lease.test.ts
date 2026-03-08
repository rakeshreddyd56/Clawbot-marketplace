/**
 * BUG-MED-004: VaultService must reject CLOSED leases.
 *
 * Previously VaultService accepted both ACTIVE and CLOSED leases for
 * vault token issuance. CLOSED leases (set when a contract is created
 * via acceptTask) have ended their lifecycle and should not grant
 * new vault tokens.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { authHeaders, onboardAgent, topup, createPostedTask } from './helpers.js';

describe('BUG-MED-004: VaultService rejects CLOSED lease', () => {
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

  async function setupContractWithClosedLease() {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_vault',
      role: 'requester',
      capabilities: ['python']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_vault',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 500);
    const task = await createPostedTask(app, requester.agentId, 'python');

    // Worker bids
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 }
    });

    // Worker reserves — gets ACTIVE lease
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Requester accepts → lease becomes CLOSED, contract is created
    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });
    const contract = accept.json<{ contractId: string }>();

    return {
      requester,
      worker,
      task,
      lease,
      contract
    };
  }

  it('rejects vault token request with CLOSED lease → 409 LEASE_INACTIVE', async () => {
    const { worker, task, lease } = await setupContractWithClosedLease();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/vault-token`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: lease.leaseToken,
        dataRef: 'dataset://tenant-a/input.csv'
      }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LEASE_INACTIVE');
  });

  it('accepts vault token request with ACTIVE lease → 200 OK', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_vault_active',
      role: 'requester',
      capabilities: ['python']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_vault_active',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 500);
    const task = await createPostedTask(app, requester.agentId, 'python');

    // Worker bids
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 }
    });

    // Worker reserves — gets ACTIVE lease
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Don't accept — lease stays ACTIVE
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/vault-token`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: lease.leaseToken,
        dataRef: 'dataset://tenant-a/input.csv'
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ grantId: string; vaultToken: string; expiresAt: string }>();
    expect(body.grantId).toBeTruthy();
    expect(body.vaultToken).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
  });
});
