/**
 * BUG-HIGH-002: Legacy deliver/accept routes must enforce policy + identity freshness.
 *
 * The legacy routes POST /v1/contracts/:contractId/deliver and
 * POST /v1/contracts/:contractId/accept previously skipped both
 * enforcePolicy() and enforceFreshIdentity(), allowing:
 *   1. No PolicyDecision record for milestone delivery/acceptance (escrow-releasing ops)
 *   2. Stale/expired Moltbook verification bypassing the freshness gate
 *
 * These tests verify:
 *   - Expired Moltbook identity → 401 REVERIFY_REQUIRED on both routes
 *   - Valid session → 200 success on both routes
 *   - PolicyDecision records written for both operations
 *   - Audit events published for milestone delivery and acceptance
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { authHeaders, onboardAgent, topup, createPostedTask } from './helpers.js';

describe('BUG-HIGH-002: legacy deliver/accept policy + freshness enforcement', () => {
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

  function policyDecisionsFor(action: string) {
    return services.store.policyDecisions.filter((d) => d.action === action);
  }

  /** Set up a full contract with a delivered milestone, returning IDs needed for tests */
  async function setupContractWithDeliveredMilestone() {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_legacy',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_legacy',
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

    // Worker reserves
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Requester accepts → contract created
    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });
    const contract = accept.json<{
      contractId: string;
      milestones: { milestoneId: string; status: string }[];
    }>();

    // Get signature for the first milestone
    const sigPreview = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract.milestones[0].milestoneId,
        content: 'test-deliverable-content'
      }
    });
    const { signature } = sigPreview.json<{ signature: string }>();

    return {
      requester,
      worker,
      task,
      contract,
      milestone: contract.milestones[0],
      signature
    };
  }

  /** Expire a specific agent's Moltbook snapshot by setting expiresAt to the past */
  function expireIdentity(agentId: string) {
    const snapshot = services.store.moltbookSnapshots.get(agentId);
    if (snapshot) {
      services.store.moltbookSnapshots.set(agentId, {
        ...snapshot,
        expiresAt: new Date(Date.now() - 60_000).toISOString()
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Legacy deliver route: POST /v1/contracts/:contractId/deliver
  // ──────────────────────────────────────────────────────────────────────────

  it('rejects legacy deliver with expired Moltbook identity → 401 REVERIFY_REQUIRED', async () => {
    const { worker, contract, milestone, signature } = await setupContractWithDeliveredMilestone();

    // Expire worker's identity
    expireIdentity(worker.agentId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: milestone.milestoneId,
        content: 'test-deliverable-content',
        signature
      }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
  });

  it('accepts legacy deliver with valid session and records PolicyDecision', async () => {
    const { worker, contract, milestone, signature } = await setupContractWithDeliveredMilestone();

    // Clear existing policy decisions to isolate this test
    const beforeCount = policyDecisionsFor('contract.milestone.deliver').length;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: milestone.milestoneId,
        content: 'test-deliverable-content',
        signature
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ artifactId: string }>();
    expect(body.artifactId).toBeTruthy();

    // Verify PolicyDecision was recorded
    const decisions = policyDecisionsFor('contract.milestone.deliver');
    expect(decisions.length).toBeGreaterThan(beforeCount);
    const lastDecision = decisions[decisions.length - 1];
    expect(lastDecision.allow).toBe(true);
    expect(lastDecision.reason).toBe('ALLOW');
    expect(lastDecision.actorAgentId).toBe(worker.agentId);
  });

  it('publishes audit event on legacy deliver success', async () => {
    const { worker, contract, milestone, signature } = await setupContractWithDeliveredMilestone();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: milestone.milestoneId,
        content: 'test-deliverable-content',
        signature
      }
    });

    expect(res.statusCode).toBe(200);

    // Check audit events for the contract
    const events = services.audit.getByEntity(contract.contractId);
    const deliverEvent = events.find((e) => e.eventType === 'milestone.delivered');
    expect(deliverEvent).toBeTruthy();
    expect(deliverEvent!.entityId).toBe(contract.contractId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Legacy accept route: POST /v1/contracts/:contractId/accept
  // ──────────────────────────────────────────────────────────────────────────

  it('rejects legacy accept with expired Moltbook identity → 401 REVERIFY_REQUIRED', async () => {
    const { requester, worker, contract, milestone, signature } = await setupContractWithDeliveredMilestone();

    // First deliver the milestone so it can be accepted
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        content: 'test-deliverable-content',
        signature
      }
    });

    // Expire requester's identity
    expireIdentity(requester.agentId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        milestoneId: milestone.milestoneId
      }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
  });

  it('accepts legacy accept with valid session and records PolicyDecision', async () => {
    const { requester, worker, contract, milestone, signature } = await setupContractWithDeliveredMilestone();

    // First deliver the milestone so it can be accepted
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        content: 'test-deliverable-content',
        signature
      }
    });

    const beforeCount = policyDecisionsFor('contract.milestone.accept').length;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        milestoneId: milestone.milestoneId
      }
    });

    expect(res.statusCode).toBe(200);

    // Verify PolicyDecision was recorded
    const decisions = policyDecisionsFor('contract.milestone.accept');
    expect(decisions.length).toBeGreaterThan(beforeCount);
    const lastDecision = decisions[decisions.length - 1];
    expect(lastDecision.allow).toBe(true);
    expect(lastDecision.reason).toBe('ALLOW');
    expect(lastDecision.actorAgentId).toBe(requester.agentId);
  });

  it('publishes audit event on legacy accept success', async () => {
    const { requester, worker, contract, milestone, signature } = await setupContractWithDeliveredMilestone();

    // First deliver the milestone
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        content: 'test-deliverable-content',
        signature
      }
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        milestoneId: milestone.milestoneId
      }
    });

    expect(res.statusCode).toBe(200);

    // Check audit events for the contract
    const events = services.audit.getByEntity(contract.contractId);
    const acceptEvent = events.find((e) => e.eventType === 'milestone.accepted');
    expect(acceptEvent).toBeTruthy();
    expect(acceptEvent!.entityId).toBe(contract.contractId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Role-based policy denial
  // ──────────────────────────────────────────────────────────────────────────

  it('denies legacy deliver for requester role (policy deny)', async () => {
    const { requester, contract, milestone, signature } = await setupContractWithDeliveredMilestone();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        milestoneId: milestone.milestoneId,
        content: 'test-deliverable-content',
        signature
      }
    });

    // Requester should not be able to deliver — only worker can
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });
});
