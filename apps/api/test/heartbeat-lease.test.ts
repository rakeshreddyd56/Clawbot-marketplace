import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

describe('heartbeat and lease management', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('heartbeat extends the lease expiry', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_heartbeat',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_heartbeat',
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
    const lease = reserve.json<{ leaseId: string; leaseToken: string; expiresAt: string }>();
    const originalExpiry = new Date(lease.expiresAt).getTime();

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
    const heartbeatBody = heartbeat.json<{ expiresAt: string }>();
    const newExpiry = new Date(heartbeatBody.expiresAt).getTime();

    // New expiry should be >= original since heartbeat resets it
    expect(newExpiry).toBeGreaterThanOrEqual(originalExpiry);
  });

  it('heartbeat rejects bad lease token', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_hb_badtok',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_hb_badtok',
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

    const heartbeat = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: 'wrong-token-xyz'
      }
    });

    expect(heartbeat.statusCode).toBe(401);
    expect(heartbeat.json<{ error: { code: string } }>().error.code).toBe('LEASE_TOKEN_INVALID');
  });

  it('heartbeat rejects non-owner worker', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_hb_owner',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_hb_owner',
      role: 'worker',
      capabilities: ['python']
    });

    const rival = await onboardAgent(app, {
      tokenSeed: 'rival_hb_owner',
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

    // rival worker tries to heartbeat for someone else's lease
    const heartbeat = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(rival.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: lease.leaseToken
      }
    });

    expect(heartbeat.statusCode).toBe(403);
    expect(heartbeat.json<{ error: { code: string } }>().error.code).toBe('LEASE_NOT_OWNER');
  });

  it('prevents second reservation on same task while active lease exists', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_double_reserve',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker1 = await onboardAgent(app, {
      tokenSeed: 'worker1_double_reserve',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 3
    });

    const worker2 = await onboardAgent(app, {
      tokenSeed: 'worker2_double_reserve',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 3
    });

    await topup(app, requester.agentId, 'requester', 200);

    const task = await createPostedTask(app, requester.agentId, 'python');

    // Both workers bid
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker1.agentId, 'worker'),
      payload: { rate: 100 }
    });

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker2.agentId, 'worker'),
      payload: { rate: 90 }
    });

    // Worker1 reserves first
    const reserve1 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker1.agentId, 'worker')
    });
    expect(reserve1.statusCode).toBe(200);

    // Worker2 tries to reserve the same task
    // The eligibility check fires first (task is now RESERVED, not POSTED) → 403 WORKER_RESERVE_BLOCKED
    // The TASK_ALREADY_RESERVED check in marketplace comes later but eligibility guard is checked first
    const reserve2 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker2.agentId, 'worker')
    });
    expect([403, 409]).toContain(reserve2.statusCode);
    const errCode = reserve2.json<{ error: { code: string } }>().error.code;
    expect(['WORKER_RESERVE_BLOCKED', 'TASK_ALREADY_RESERVED', 'TASK_NOT_POSTED']).toContain(errCode);
  });

  it('requires a bid before reservation', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_no_bid',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_no_bid',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    // Skip bidding and try to reserve directly
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reserve.statusCode).toBe(409);
    expect(reserve.json<{ error: { code: string } }>().error.code).toBe('BID_REQUIRED');
  });

  it('prevents requester from reserving their own task', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_self_reserve',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    // Policy enforcement: only workers can reserve
    expect([400, 403]).toContain(reserve.statusCode);
  });

  it('accepts task fails when lease token is wrong', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_accept_bad_token',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_accept_bad_token',
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

    // Accept with wrong token
    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: 'bad-token-xyz'
      }
    });

    expect(accept.statusCode).toBe(401);
    expect(accept.json<{ error: { code: string } }>().error.code).toBe('LEASE_TOKEN_INVALID');
  });

  it('task heartbeat requires task.heartbeat policy', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_hb_policy',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    // Try heartbeat as requester without a lease
    const heartbeat = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        leaseId: 'fake-lease-id',
        leaseToken: 'fake-token'
      }
    });

    // Requesters cannot heartbeat
    expect([400, 403, 404]).toContain(heartbeat.statusCode);
  });

  it('task eligibility endpoint returns canReserve info', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_eligibility',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_eligibility',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    const eligibility = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/eligibility`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{
      taskId: string;
      canReserve: boolean;
      trustTier: string;
      blockReasons: unknown[];
    }>();
    expect(body.taskId).toBe(task.taskId);
    expect(typeof body.canReserve).toBe('boolean');
    expect(body.trustTier).toBeTruthy();
  });

  it('listing bids is restricted to requester and moderators', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_bids_list',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_bids_list',
      role: 'worker',
      capabilities: ['python']
    });

    const rival = await onboardAgent(app, {
      tokenSeed: 'rival_bids_list',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 80 }
    });

    // Requester can see bids
    const requesterBids = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(requesterBids.statusCode).toBe(200);
    const bids = requesterBids.json<{ bids: Array<{ bidId: string; rate: number }> }>();
    expect(bids.bids.length).toBe(1);
    expect(bids.bids[0].rate).toBe(80);

    // Rival worker cannot see bids
    const rivalBids = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(rival.agentId, 'worker')
    });
    expect(rivalBids.statusCode).toBe(403);
    expect(rivalBids.json<{ error: { code: string } }>().error.code).toBe('BIDS_FORBIDDEN');
  });

  it('cancel task while reserved closes the lease', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_cancel_reserved',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_cancel_reserved',
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

    // Cancel the reserved task
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/cancel`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { reasonCode: 'OWNER_CANCELED' }
    });

    expect(cancel.statusCode).toBe(200);
    expect(cancel.json<{ status: string }>().status).toBe('CLOSED');
  });
});
