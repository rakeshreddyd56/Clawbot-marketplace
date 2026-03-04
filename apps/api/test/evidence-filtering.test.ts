/**
 * BUG-MED-002: Evidence endpoint must NOT leak global policy decisions.
 * - Dispute parties should only see decisions for their own agents or the dispute/contract entities.
 * - Admin/moderator should see all decisions (unfiltered).
 * - Unrelated agents' decisions must be excluded for non-privileged users.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

describe('BUG-MED-002: evidence endpoint policy decision filtering', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  /**
   * Helper: set up a dispute between requester and worker, returning all IDs.
   */
  async function setupDispute(suffix: string) {
    const requester = await onboardAgent(app, {
      tokenSeed: `req_evfilt_${suffix}`,
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: `wrk_evfilt_${suffix}`,
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
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });
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

    return {
      requester,
      worker,
      task,
      contract,
      dispute
    };
  }

  it('dispute party sees only decisions for their agents, not global decisions', async () => {
    // Set up two independent disputes with different agents
    const d1 = await setupDispute('a');
    const d2 = await setupDispute('b');

    // Requester of dispute 1 fetches evidence
    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${d1.dispute.disputeId}/evidence`,
      headers: authHeaders(d1.requester.agentId, 'requester')
    });

    expect(evidence.statusCode).toBe(200);
    const body = evidence.json<{
      policyDecisions: Array<{ actorAgentId: string; entityId?: string }>;
    }>();

    // All returned decisions must be for the dispute parties or the dispute/contract entities
    const allowedActors = new Set([d1.requester.agentId, d1.worker.agentId]);
    const allowedEntities = new Set([d1.dispute.disputeId, d1.contract.contractId]);

    for (const decision of body.policyDecisions) {
      const isPartyDecision = allowedActors.has(decision.actorAgentId);
      const isEntityDecision = decision.entityId && allowedEntities.has(decision.entityId);
      expect(
        isPartyDecision || isEntityDecision,
        `Decision by ${decision.actorAgentId} with entity ${decision.entityId} should not be visible to dispute 1 parties`
      ).toBe(true);
    }

    // Specifically ensure no decisions from dispute 2's agents leaked through
    const d2Actors = new Set([d2.requester.agentId, d2.worker.agentId]);
    const leakedDecisions = body.policyDecisions.filter(
      d => d2Actors.has(d.actorAgentId) && !allowedActors.has(d.actorAgentId)
    );
    expect(leakedDecisions).toHaveLength(0);
  });

  it('unrelated agent decisions are excluded from evidence', async () => {
    const d1 = await setupDispute('excl');

    // Onboard an unrelated agent and make them do something to generate policy decisions
    const unrelated = await onboardAgent(app, {
      tokenSeed: 'unrelated_evfilt',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    await topup(app, unrelated.agentId, 'requester', 50);
    await createPostedTask(app, unrelated.agentId, 'python');

    // Fetch evidence for dispute 1
    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${d1.dispute.disputeId}/evidence`,
      headers: authHeaders(d1.requester.agentId, 'requester')
    });

    expect(evidence.statusCode).toBe(200);
    const body = evidence.json<{
      policyDecisions: Array<{ actorAgentId: string }>;
    }>();

    // No decisions from the unrelated agent should appear
    const unrelatedDecisions = body.policyDecisions.filter(
      d => d.actorAgentId === unrelated.agentId
    );
    expect(unrelatedDecisions).toHaveLength(0);
  });

  it('admin sees all policy decisions (unfiltered)', async () => {
    const d1 = await setupDispute('admin');

    // Generate extra decisions from unrelated agent
    const unrelated = await onboardAgent(app, {
      tokenSeed: 'unrelated_admin_ev',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    await topup(app, unrelated.agentId, 'requester', 50);
    await createPostedTask(app, unrelated.agentId, 'python');

    // Admin fetches evidence — should see ALL recent decisions
    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${d1.dispute.disputeId}/evidence`,
      headers: authHeaders(d1.requester.agentId, 'admin')
    });

    expect(evidence.statusCode).toBe(200);
    const body = evidence.json<{
      policyDecisions: Array<{ actorAgentId: string }>;
    }>();

    // Admin should see decisions from unrelated agent
    const unrelatedDecisions = body.policyDecisions.filter(
      d => d.actorAgentId === unrelated.agentId
    );
    expect(unrelatedDecisions.length).toBeGreaterThan(0);
  });

  it('moderator sees all policy decisions (unfiltered)', async () => {
    const d1 = await setupDispute('mod');

    // Generate extra decisions from unrelated agent
    const unrelated = await onboardAgent(app, {
      tokenSeed: 'unrelated_mod_ev',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    await topup(app, unrelated.agentId, 'requester', 50);
    await createPostedTask(app, unrelated.agentId, 'python');

    // Moderator fetches evidence — should see ALL recent decisions
    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${d1.dispute.disputeId}/evidence`,
      headers: authHeaders(d1.requester.agentId, 'moderator')
    });

    expect(evidence.statusCode).toBe(200);
    const body = evidence.json<{
      policyDecisions: Array<{ actorAgentId: string }>;
    }>();

    // Moderator should see decisions from unrelated agent
    const unrelatedDecisions = body.policyDecisions.filter(
      d => d.actorAgentId === unrelated.agentId
    );
    expect(unrelatedDecisions.length).toBeGreaterThan(0);
  });

  it('policy decisions include actorAgentId field', async () => {
    const d1 = await setupDispute('fields');

    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${d1.dispute.disputeId}/evidence`,
      headers: authHeaders(d1.requester.agentId, 'requester')
    });

    expect(evidence.statusCode).toBe(200);
    const body = evidence.json<{
      policyDecisions: Array<{ actorAgentId: string; decisionId: string; action: string }>;
    }>();

    expect(body.policyDecisions.length).toBeGreaterThan(0);

    // Every returned decision should have the actorAgentId field populated
    for (const decision of body.policyDecisions) {
      expect(decision.actorAgentId).toBeDefined();
      expect(typeof decision.actorAgentId).toBe('string');
      expect(decision.actorAgentId.length).toBeGreaterThan(0);
    }
  });
});
