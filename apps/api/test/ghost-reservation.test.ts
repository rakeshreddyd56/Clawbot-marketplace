import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';
import type { Store } from '../src/types/domain.js';
import type { AppServices } from '../src/app.js';

/**
 * TASK-ENFORCE-006: Ghost reservation detection + auto-sanction tests.
 *
 * Ghost reservation = a worker repeatedly reserves tasks and lets leases expire
 * without completing them. The system detects this pattern and applies
 * progressive sanctions (SUSPEND → BAN).
 */
describe('TASK-ENFORCE-006: ghost reservation detection', () => {
  let app: FastifyInstance;
  let store: Store;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
    store = built.services.store;
  });

  afterEach(async () => {
    await app.close();
  });

  async function setupAgents() {
    const requester = await onboardAgent(app, {
      tokenSeed: 'ghost_requester',
      role: 'requester',
      capabilities: ['python'],
      maxConcurrency: 10
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'ghost_worker',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 10
    });

    await topup(app, requester.agentId, 'requester', 10000);

    return { requester, worker };
  }

  async function reserveAndExpire(app: FastifyInstance, store: Store, requesterId: string, workerId: string) {
    const task = await createPostedTask(app, requesterId, 'python');

    // Bid on the task
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(workerId, 'worker'),
      payload: { rate: 50 }
    });

    // Reserve the task
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(workerId, 'worker')
    });
    expect(reserve.statusCode).toBe(200);

    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Manually expire the lease by setting leaseExpiresAt to the past
    const existing = store.leases.get(lease.leaseId)!;
    store.leases.set(lease.leaseId, {
      ...existing,
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString()
    });

    // Trigger the expiry check via heartbeat (which calls expireLeaseIfStale)
    const heartbeat = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(workerId, 'worker'),
      payload: { leaseId: lease.leaseId, leaseToken: lease.leaseToken }
    });
    expect(heartbeat.statusCode).toBe(409); // LEASE_EXPIRED

    return lease.leaseId;
  }

  async function reserveAndAccept(app: FastifyInstance, requesterId: string, workerId: string) {
    const task = await createPostedTask(app, requesterId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(workerId, 'worker'),
      payload: { rate: 50 }
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(workerId, 'worker')
    });

    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requesterId, 'requester'),
      payload: lease
    });
  }

  it('tracks lease outcomes in the leaseOutcomeLog', async () => {
    const { requester, worker } = await setupAgents();

    // Reserve and let expire
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);

    const log = store.leaseOutcomeLog.get(worker.agentId);
    expect(log).toBeDefined();
    expect(log!.length).toBe(1);
    expect(log![0].outcome).toBe('EXPIRED');
  });

  it('tracks CLOSED outcomes when lease is accepted', async () => {
    const { requester, worker } = await setupAgents();

    await reserveAndAccept(app, requester.agentId, worker.agentId);

    const log = store.leaseOutcomeLog.get(worker.agentId);
    expect(log).toBeDefined();
    expect(log!.some((entry) => entry.outcome === 'CLOSED')).toBe(true);
  });

  it('does NOT sanction below the minimum lease threshold (3 leases)', async () => {
    const { requester, worker } = await setupAgents();

    // Only 2 expired leases — below threshold
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);

    const sanctions = store.sanctions.get(worker.agentId);
    expect(sanctions ?? []).toHaveLength(0);

    // Agent should still be ACTIVE
    const agent = store.agents.get(worker.agentId);
    expect(agent!.profile.status).toBe('ACTIVE');
  });

  it('applies SUSPEND sanction when ghost ratio exceeds threshold (3/3 = 100%)', async () => {
    const { requester, worker } = await setupAgents();

    // 3 expired leases in a row — 100% ghost ratio, well above 60% threshold
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);

    const sanctions = store.sanctions.get(worker.agentId);
    expect(sanctions).toBeDefined();
    expect(sanctions!.length).toBeGreaterThanOrEqual(1);
    expect(sanctions![0].type).toBe('SUSPEND');
    expect(sanctions![0].reasonCode).toBe('GHOST_RESERVATION');

    // Agent status should be SUSPENDED
    const agent = store.agents.get(worker.agentId);
    expect(agent!.profile.status).toBe('SUSPENDED');
  });

  it('does NOT sanction when ghost ratio is below threshold', async () => {
    const { requester, worker } = await setupAgents();

    // 2 successful + 1 expired = 33% ghost ratio (below 60%)
    await reserveAndAccept(app, requester.agentId, worker.agentId);
    await reserveAndAccept(app, requester.agentId, worker.agentId);
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);

    const sanctions = store.sanctions.get(worker.agentId);
    expect(sanctions ?? []).toHaveLength(0);

    const agent = store.agents.get(worker.agentId);
    expect(agent!.profile.status).toBe('ACTIVE');
  });

  it('publishes violation.ghost_reservation_detected audit event', async () => {
    const { requester, worker } = await setupAgents();

    await reserveAndExpire(app, store, requester.agentId, worker.agentId);
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);
    await reserveAndExpire(app, store, requester.agentId, worker.agentId);

    // Check that the violation event was published
    const eventsRes = await app.inject({
      method: 'GET',
      url: `/v1/events/${worker.agentId}`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    const body = eventsRes.json<{ events: { eventType: string; payload: Record<string, unknown> }[] }>();
    const violationEvent = body.events.find((e) => e.eventType === 'violation.ghost_reservation_detected');
    expect(violationEvent).toBeDefined();
    expect(violationEvent!.payload).toHaveProperty('ghostRatio');
    expect(violationEvent!.payload).toHaveProperty('expiredCount');
    expect(violationEvent!.payload).toHaveProperty('totalLeases');
  });
});
