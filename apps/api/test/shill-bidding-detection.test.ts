import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

describe('TASK-ENFORCE-003: shill bidding detection (same-owner check)', () => {
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

  it('blocks reservation when requester and worker share the same ownerXHandle', async () => {
    // Onboard two distinct agents
    const requester = await onboardAgent(app, {
      tokenSeed: 'shill_requester_001',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'shill_worker_001',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 500);

    // Tamper the moltbook snapshot so both agents share the same ownerXHandle
    const sharedHandle = 'owner_colluding_human';
    const reqSnapshot = services.store.moltbookSnapshots.get(requester.agentId)!;
    const wrkSnapshot = services.store.moltbookSnapshots.get(worker.agentId)!;

    services.store.moltbookSnapshots.set(requester.agentId, {
      ...reqSnapshot,
      agent: { ...reqSnapshot.agent, owner: { ...reqSnapshot.agent.owner, xHandle: sharedHandle } }
    });
    services.store.moltbookSnapshots.set(worker.agentId, {
      ...wrkSnapshot,
      agent: { ...wrkSnapshot.agent, owner: { ...wrkSnapshot.agent.owner, xHandle: sharedHandle } }
    });

    // Create a task and bid
    const task = await createPostedTask(app, requester.agentId, 'python');

    const bid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 50 }
    });
    expect(bid.statusCode).toBe(200);

    // Attempt to reserve — should be blocked by shill detection
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reserve.statusCode).toBe(403);
    const body = reserve.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('SHILL_BID_DETECTED');
    expect(body.error.message).toContain('same owner');
  });

  it('allows reservation when requester and worker have different owners', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'legit_requester_001',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'legit_worker_001',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 500);

    // Different token seeds → different agentIds → different ownerXHandles by default
    const reqSnapshot = services.store.moltbookSnapshots.get(requester.agentId)!;
    const wrkSnapshot = services.store.moltbookSnapshots.get(worker.agentId)!;
    expect(reqSnapshot.agent.owner.xHandle).not.toBe(wrkSnapshot.agent.owner.xHandle);

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 50 }
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reserve.statusCode).toBe(200);
    const lease = reserve.json<{ leaseId: string; leaseToken: string; expiresAt: string }>();
    expect(lease.leaseId).toBeDefined();
    expect(lease.leaseToken).toBeDefined();
  });

  it('publishes violation.shill_bid_detected audit event on detection', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'audit_requester_001',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'audit_worker_001',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 500);

    // Force same owner
    const sharedHandle = 'owner_audit_colluder';
    const reqSnap = services.store.moltbookSnapshots.get(requester.agentId)!;
    const wrkSnap = services.store.moltbookSnapshots.get(worker.agentId)!;
    services.store.moltbookSnapshots.set(requester.agentId, {
      ...reqSnap,
      agent: { ...reqSnap.agent, owner: { ...reqSnap.agent.owner, xHandle: sharedHandle } }
    });
    services.store.moltbookSnapshots.set(worker.agentId, {
      ...wrkSnap,
      agent: { ...wrkSnap.agent, owner: { ...wrkSnap.agent.owner, xHandle: sharedHandle } }
    });

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 50 }
    });

    // Capture event count before shill attempt
    const eventCountBefore = services.audit.getAll().length;

    // Trigger shill detection (will fail with 403)
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    // Check audit ledger directly for the violation event
    const allEvents = services.audit.getAll();
    expect(allEvents.length).toBeGreaterThan(eventCountBefore);

    const shillEvents = allEvents.filter((e) => e.eventType === 'violation.shill_bid_detected');
    expect(shillEvents.length).toBeGreaterThanOrEqual(1);

    const latest = shillEvents[shillEvents.length - 1];
    expect(latest.payload).toMatchObject({
      requesterAgentId: requester.agentId,
      workerAgentId: worker.agentId,
      ownerXHandle: sharedHandle
    });
  });

  it('does not block when one agent has no moltbook snapshot', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'nosnap_requester_001',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'nosnap_worker_001',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 500);

    // Remove worker's moltbook snapshot to test the guard clause
    services.store.moltbookSnapshots.delete(worker.agentId);

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 50 }
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    // Should pass through shill check (no snapshot to compare)
    // May fail for other reasons, but NOT for SHILL_BID_DETECTED
    if (reserve.statusCode !== 200) {
      const body = reserve.json<{ error: { code: string } }>();
      expect(body.error.code).not.toBe('SHILL_BID_DETECTED');
    }
  });

  it('blocks shill attempt even when worker bids on multiple tasks from same owner', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'multi_requester_001',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'multi_worker_001',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 5
    });

    await topup(app, requester.agentId, 'requester', 1000);

    // Force same owner
    const sharedHandle = 'owner_multi_colluder';
    const reqSnap = services.store.moltbookSnapshots.get(requester.agentId)!;
    const wrkSnap = services.store.moltbookSnapshots.get(worker.agentId)!;
    services.store.moltbookSnapshots.set(requester.agentId, {
      ...reqSnap,
      agent: { ...reqSnap.agent, owner: { ...reqSnap.agent.owner, xHandle: sharedHandle } }
    });
    services.store.moltbookSnapshots.set(worker.agentId, {
      ...wrkSnap,
      agent: { ...wrkSnap.agent, owner: { ...wrkSnap.agent.owner, xHandle: sharedHandle } }
    });

    // Create two tasks from same requester
    const task1 = await createPostedTask(app, requester.agentId, 'python');
    const task2 = await createPostedTask(app, requester.agentId, 'python');

    // Bid on both
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task1.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 50 }
    });
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task2.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 75 }
    });

    // Both reservations should be blocked
    const reserve1 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task1.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(reserve1.statusCode).toBe(403);
    expect(reserve1.json<{ error: { code: string } }>().error.code).toBe('SHILL_BID_DETECTED');

    const reserve2 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task2.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(reserve2.statusCode).toBe(403);
    expect(reserve2.json<{ error: { code: string } }>().error.code).toBe('SHILL_BID_DETECTED');
  });

  it('bidding itself is allowed even with same owner (detection is at reserve time)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'bidok_requester_001',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'bidok_worker_001',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 500);

    // Force same owner
    const sharedHandle = 'owner_bidtest';
    const reqSnap = services.store.moltbookSnapshots.get(requester.agentId)!;
    const wrkSnap = services.store.moltbookSnapshots.get(worker.agentId)!;
    services.store.moltbookSnapshots.set(requester.agentId, {
      ...reqSnap,
      agent: { ...reqSnap.agent, owner: { ...reqSnap.agent.owner, xHandle: sharedHandle } }
    });
    services.store.moltbookSnapshots.set(worker.agentId, {
      ...wrkSnap,
      agent: { ...wrkSnap.agent, owner: { ...wrkSnap.agent.owner, xHandle: sharedHandle } }
    });

    const task = await createPostedTask(app, requester.agentId, 'python');

    // Bidding should succeed — shill check is only on reserve
    const bid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 50 }
    });

    expect(bid.statusCode).toBe(200);
    expect(bid.json<{ bidId: string }>().bidId).toBeDefined();
  });
});
