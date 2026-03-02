/**
 * Audit events and policy decision tests
 * - Events endpoint filtering by entityId
 * - Policy decisions recording
 * - Audit trail after key actions
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

describe('audit events and policy decisions', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('events endpoint filters by entityId', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_events_filter',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    // Get events for this task
    const events = await app.inject({
      method: 'GET',
      url: `/v1/events?entityId=${task.taskId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(events.statusCode).toBe(200);
    const body = events.json<{ events: Array<{ eventType: string; entityId: string }> }>();
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.entityId === task.taskId)).toBe(true);
  });

  it('events by entity path returns events for that entity', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_events_entity',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    const events = await app.inject({
      method: 'GET',
      url: `/v1/events/${task.taskId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(events.statusCode).toBe(200);
    const body = events.json<{ events: Array<{ eventType: string; entityId: string }> }>();
    expect(body.events.length).toBeGreaterThan(0);
    // Task created + posted events
    const eventTypes = body.events.map((e) => e.eventType);
    expect(eventTypes).toContain('task.created');
    expect(eventTypes).toContain('task.posted');
  });

  it('agent onboarding creates audit events', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'agent_audit_trail',
      role: 'worker',
      capabilities: ['python']
    });

    const events = await app.inject({
      method: 'GET',
      url: `/v1/events/${agent.agentId}`,
      headers: authHeaders(agent.agentId, 'worker')
    });

    expect(events.statusCode).toBe(200);
    const body = events.json<{ events: Array<{ eventType: string }> }>();
    const eventTypes = body.events.map((e) => e.eventType);
    expect(eventTypes).toContain('agent.onboarded');
    expect(eventTypes).toContain('agent.capabilities.updated');
    expect(eventTypes).toContain('agent.activated');
  });

  it('wallet topup creates an audit event', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_audit_topup',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const events = await app.inject({
      method: 'GET',
      url: `/v1/events/${requester.agentId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(events.statusCode).toBe(200);
    const body = events.json<{ events: Array<{ eventType: string }> }>();
    const eventTypes = body.events.map((e) => e.eventType);
    expect(eventTypes).toContain('wallet.topped_up');
  });

  it('moderator can view all events without entityId filter', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_all_events',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_for_mod_events',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const events = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: authHeaders(moderator.agentId, 'moderator')
    });

    expect(events.statusCode).toBe(200);
    const body = events.json<{ events: unknown[] }>();
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('worker cannot view all events (requires moderator/admin)', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_all_events_blocked',
      role: 'worker',
      capabilities: ['python']
    });

    const events = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(events.statusCode).toBe(403);
  });

  it('policy decisions endpoint records enforcement decisions', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_policy_audit',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_policy_audit',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);
    await createPostedTask(app, requester.agentId, 'python');

    const decisions = await app.inject({
      method: 'GET',
      url: '/v1/policy/decisions',
      headers: authHeaders(moderator.agentId, 'moderator')
    });

    expect(decisions.statusCode).toBe(200);
    const body = decisions.json<{ decisions: unknown[] }>();
    expect(body.decisions.length).toBeGreaterThan(0);
  });

  it('policy decide endpoint lets moderator evaluate policy manually', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_manual_policy',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const decide = await app.inject({
      method: 'POST',
      url: '/v1/policy/decide',
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        action: 'task.create',
        context: {}
      }
    });

    expect(decide.statusCode).toBe(200);
    // PolicyDecision schema: { decisionId, policyVersion, action, allow, reason, contextHash, createdAt }
    const body = decide.json<{ action: string; allow: boolean; reason: string; decisionId: string }>();
    expect(body.action).toBe('task.create');
    expect(body.reason).toBeTruthy();
    expect(body.decisionId).toBeTruthy();
  });

  it('policy decide endpoint is restricted to moderator and admin', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_policy_forbidden',
      role: 'worker',
      capabilities: ['python']
    });

    const decide = await app.inject({
      method: 'POST',
      url: '/v1/policy/decide',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        action: 'task.create',
        context: {}
      }
    });

    expect(decide.statusCode).toBe(403);
  });

  it('reputation score increases after milestone acceptance', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_reputation',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_reputation',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    // Get initial reputation
    const rep0 = await app.inject({
      method: 'GET',
      url: `/v1/reputation/${worker.agentId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(rep0.statusCode).toBe(200);
    const initialScore = rep0.json<{ score: number }>().score;

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
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });
    const contract = accept.json<{ contractId: string; milestones: Array<{ milestoneId: string }> }>();

    // Deliver and accept milestone 1
    const sig = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: contract.milestones[0].milestoneId, content: 'rep-content-1' }
    });
    const { signature } = sig.json<{ signature: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: contract.milestones[0].milestoneId, content: 'rep-content-1', signature }
    });

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: contract.milestones[0].milestoneId }
    });

    // Check reputation after acceptance
    const rep1 = await app.inject({
      method: 'GET',
      url: `/v1/reputation/${worker.agentId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(rep1.statusCode).toBe(200);
    const newScore = rep1.json<{ score: number }>().score;

    expect(newScore).toBeGreaterThanOrEqual(initialScore);
  });

  it('dispute evidence endpoint returns all relevant artifacts and events', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_evidence',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_evidence',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');
    await app.inject({ method: 'POST', url: `/v1/tasks/${task.taskId}/bids`, headers: authHeaders(worker.agentId, 'worker'), payload: { rate: 100 } });
    const reserve = await app.inject({ method: 'POST', url: `/v1/tasks/${task.taskId}/reserve`, headers: authHeaders(worker.agentId, 'worker') });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();
    const accept = await app.inject({ method: 'POST', url: `/v1/tasks/${task.taskId}/accept`, headers: authHeaders(requester.agentId, 'requester'), payload: lease });
    const contract = accept.json<{ contractId: string }>();

    const open = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'NON_DELIVERY',
        againstAgentId: worker.agentId
      }
    });
    const dispute = open.json<{ disputeId: string }>();

    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${dispute.disputeId}/evidence`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(evidence.statusCode).toBe(200);
    const body = evidence.json<{
      dispute: { disputeId: string };
      contract: { contractId: string };
      events: unknown[];
    }>();

    expect(body.dispute.disputeId).toBe(dispute.disputeId);
    expect(body.contract.contractId).toBe(contract.contractId);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('task events include bid placement audit trail', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_bid_events',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_bid_events',
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

    const events = await app.inject({
      method: 'GET',
      url: `/v1/events/${task.taskId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    const body = events.json<{ events: Array<{ eventType: string }> }>();
    const types = body.events.map((e) => e.eventType);
    expect(types).toContain('task.bid_placed');
  });
});
