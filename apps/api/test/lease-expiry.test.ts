/**
 * Lease expiry and security tests
 *
 * Adversarial tests for lease/heartbeat:
 * - Heartbeat after lease expires → LEASE_EXPIRED (409)
 * - Accept task after lease expires → LEASE_EXPIRED (409)
 * - Scope access with expired lease → LEASE_EXPIRED (409)
 * - Heartbeat with wrong lease token → LEASE_TOKEN_INVALID (401)
 * - Rival worker heartbeating another's lease → LEASE_NOT_OWNER (403)
 *
 * Store manipulation is used to set leaseExpiresAt in the past
 * without waiting for the real 2-minute TTL.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../src/app.js';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

// -----------------------------------------------------------------------
// Helper: bid and reserve a task, returning leaseId + leaseToken
// -----------------------------------------------------------------------
async function bidAndReserve(
  app: FastifyInstance,
  taskId: string,
  workerId: string
): Promise<{ leaseId: string; leaseToken: string }> {
  const bid = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 80 }
  });
  if (bid.statusCode !== 200) throw new Error(`bid failed: ${bid.statusCode} ${bid.body}`);

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${taskId}/reserve`,
    headers: authHeaders(workerId, 'worker')
  });
  if (reserve.statusCode !== 200) throw new Error(`reserve failed: ${reserve.statusCode} ${reserve.body}`);

  return reserve.json<{ leaseId: string; leaseToken: string }>();
}

describe('lease expiry and token security', () => {
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

  // ------------------------------------------------------------------
  // Heartbeat after expiry
  // ------------------------------------------------------------------

  it('heartbeat after lease expires returns LEASE_EXPIRED', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'le_req_hb_ttl',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'le_wrk_hb_ttl',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');
    const { leaseId, leaseToken } = await bidAndReserve(app, task.taskId, worker.agentId);

    // Manually expire the lease via direct store manipulation
    const lease = services.store.leases.get(leaseId)!;
    services.store.leases.set(leaseId, {
      ...lease,
      leaseExpiresAt: new Date(Date.now() - 5000).toISOString() // 5 seconds in the past
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { leaseId, leaseToken }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LEASE_EXPIRED');
  });

  // ------------------------------------------------------------------
  // Accept after expiry
  // ------------------------------------------------------------------

  it('accept task after lease expires returns LEASE_EXPIRED', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'le_req_acc_ttl',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'le_wrk_acc_ttl',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');
    const { leaseId, leaseToken } = await bidAndReserve(app, task.taskId, worker.agentId);

    // Manually expire the lease
    const lease = services.store.leases.get(leaseId)!;
    services.store.leases.set(leaseId, {
      ...lease,
      leaseExpiresAt: new Date(Date.now() - 5000).toISOString()
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { leaseId, leaseToken }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LEASE_EXPIRED');
  });

  // ------------------------------------------------------------------
  // Scope access with expired lease
  // ------------------------------------------------------------------

  it('scope access with expired lease returns LEASE_EXPIRED', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'le_req_scope_ttl',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'le_wrk_scope_ttl',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');
    const { leaseId, leaseToken } = await bidAndReserve(app, task.taskId, worker.agentId);

    // Manually expire the lease
    const lease = services.store.leases.get(leaseId)!;
    services.store.leases.set(leaseId, {
      ...lease,
      leaseExpiresAt: new Date(Date.now() - 5000).toISOString()
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/scope`,
      headers: authHeaders(worker.agentId, 'worker'),
      query: { leaseId, leaseToken }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LEASE_EXPIRED');
  });

  // ------------------------------------------------------------------
  // Wrong lease token
  // ------------------------------------------------------------------

  it('heartbeat with wrong leaseToken returns LEASE_TOKEN_INVALID (401)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'le_req_wrong_token',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'le_wrk_wrong_token',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');
    const { leaseId } = await bidAndReserve(app, task.taskId, worker.agentId);

    // Use a completely wrong lease token (worker is the owner, but token is wrong)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { leaseId, leaseToken: 'totally_wrong_token_abc123' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LEASE_TOKEN_INVALID');
  });

  it('accept with wrong leaseToken returns LEASE_TOKEN_INVALID (401)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'le_req_accept_wrong_tok',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'le_wrk_accept_wrong_tok',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');
    const { leaseId } = await bidAndReserve(app, task.taskId, worker.agentId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { leaseId, leaseToken: 'tampered_token_xyz' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LEASE_TOKEN_INVALID');
  });

  // ------------------------------------------------------------------
  // Rival worker heartbeat attack
  // ------------------------------------------------------------------

  it('rival worker cannot heartbeat on another worker lease (LEASE_NOT_OWNER)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'le_req_rival_hb',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'le_wrk_rival_hb',
      role: 'worker',
      capabilities: ['python']
    });
    const rival = await onboardAgent(app, {
      tokenSeed: 'le_rival_hb',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');
    const { leaseId, leaseToken } = await bidAndReserve(app, task.taskId, worker.agentId);

    // Rival worker tries to heartbeat using the real leaseId+leaseToken
    // (they somehow got hold of the token — still must be blocked by owner check)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(rival.agentId, 'worker'),
      payload: { leaseId, leaseToken }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LEASE_NOT_OWNER');
  });

  // ------------------------------------------------------------------
  // Valid heartbeat (positive path — lease keeps task alive)
  // ------------------------------------------------------------------

  it('heartbeat with valid token extends the lease expiry', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'le_req_valid_hb',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'le_wrk_valid_hb',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');
    const { leaseId, leaseToken } = await bidAndReserve(app, task.taskId, worker.agentId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { leaseId, leaseToken }
    });

    expect(res.statusCode).toBe(200);
    const { expiresAt } = res.json<{ expiresAt: string }>();
    // New expiry should be in the future
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
