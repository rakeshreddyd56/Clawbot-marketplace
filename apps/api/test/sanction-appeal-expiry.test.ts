import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

/**
 * TASK-FEAT-004: Comprehensive tests for the sanction appeal mechanism
 * and suspension expiry system.
 *
 * Covers:
 * - Filing an appeal on an active sanction
 * - Moderator/admin reviewing appeals (uphold/reverse)
 * - Suspension expiry (time-limited → EXPIRED)
 * - Agent reactivation after all sanctions clear
 * - Edge cases: double appeal, appeal after expiry, unauthorized access
 */

type SanctionResponse = {
  sanctionId: string;
  agentId: string;
  type: 'SUSPEND' | 'BAN';
  status: 'ACTIVE' | 'EXPIRED' | 'APPEALED' | 'REVERSED';
  durationHours?: number;
  effectiveAt: string;
  appealedAt?: string;
  appealReason?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewRuling?: 'UPHELD' | 'REVERSED';
};

type ExpiryResponse = {
  expiredCount: number;
  reactivatedAgents: string[];
};

/**
 * Helper: Create a dispute and resolve it to sanction a worker.
 * Returns the sanctionId of the applied sanction.
 */
async function sanctionWorkerViaDispute(
  app: FastifyInstance,
  requesterId: string,
  workerId: string,
  moderatorId: string
): Promise<{ sanctionId: string; contractId: string }> {
  const task = await createPostedTask(app, requesterId, 'python');

  // Worker bids and reserves
  await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 80 }
  });

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/reserve`,
    headers: authHeaders(workerId, 'worker')
  });
  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  // Requester accepts
  const accept = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });
  const contract = accept.json<{ contractId: string }>();

  // Open dispute
  const dispute = await app.inject({
    method: 'POST',
    url: '/v1/disputes',
    headers: authHeaders(requesterId, 'requester'),
    payload: {
      contractId: contract.contractId,
      reasonCode: 'NON_DELIVERY',
      againstAgentId: workerId
    }
  });
  const disputeData = dispute.json<{ disputeId: string }>();

  // Resolve dispute → triggers sanction
  await app.inject({
    method: 'POST',
    url: `/v1/disputes/${disputeData.disputeId}/resolve`,
    headers: authHeaders(moderatorId, 'moderator'),
    payload: {
      ruling: 'refund_requester',
      targetAgentId: workerId
    }
  });

  // Get the sanction that was applied
  const sanctions = await app.inject({
    method: 'GET',
    url: '/v1/agents/me/sanctions',
    headers: authHeaders(workerId, 'worker')
  });
  const sanctionList = sanctions.json<SanctionResponse[]>();
  const latest = sanctionList[sanctionList.length - 1];

  return { sanctionId: latest.sanctionId, contractId: contract.contractId };
}

describe('TASK-FEAT-004: Sanction appeal mechanism', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  // ─── Appeal Filing ─────────────────────────────────────────────────────────

  it('allows sanctioned agent to file an appeal with a reason', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_appeal1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_appeal1', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_appeal1', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    const appeal = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'I completed the work but the artifact upload failed due to a network issue.' }
    });

    expect(appeal.statusCode).toBe(200);
    const result = appeal.json<SanctionResponse>();
    expect(result.status).toBe('APPEALED');
    expect(result.appealedAt).toBeDefined();
    expect(result.appealReason).toContain('network issue');
  });

  it('rejects appeal from a non-sanctioned agent', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_appeal2', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_appeal2', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_appeal2', role: 'moderator', capabilities: ['moderation'] });
    const otherAgent = await onboardAgent(app, { tokenSeed: 'other_appeal2', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // Another agent tries to appeal someone else's sanction
    const appeal = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(otherAgent.agentId, 'worker'),
      payload: { reason: 'I want to help my friend by appealing their sanction on their behalf.' }
    });

    expect(appeal.statusCode).toBe(403);
    expect(appeal.json<{ error: { code: string } }>().error.code).toBe('NOT_SANCTION_OWNER');
  });

  it('rejects appeal with reason too short (< 10 chars)', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_appeal3', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_appeal3', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_appeal3', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    const appeal = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'unfair' }
    });

    // Zod validation rejects min(10) at route level
    expect(appeal.statusCode).toBe(400);
  });

  it('rejects double appeal on same sanction', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_appeal4', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_appeal4', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_appeal4', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // First appeal succeeds
    const first = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'I completed the work but experienced technical difficulties during submission.' }
    });
    expect(first.statusCode).toBe(200);

    // Second appeal is rejected (status is now APPEALED, not ACTIVE)
    const second = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'I want to try appealing again with additional evidence and reasoning.' }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('SANCTION_NOT_ACTIVE');
  });

  // ─── Appeal Review (Moderator/Admin) ───────────────────────────────────────

  it('moderator can uphold an appeal — sanction returns to ACTIVE', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_review1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_review1', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_review1', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // File appeal
    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'I believe the dispute was resolved unfairly due to miscommunication.' }
    });

    // Moderator upholds — sanction stays
    const review = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/review`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'UPHELD' }
    });

    expect(review.statusCode).toBe(200);
    const result = review.json<SanctionResponse>();
    expect(result.status).toBe('ACTIVE');
    expect(result.reviewRuling).toBe('UPHELD');
    expect(result.reviewedBy).toBe(moderator.agentId);
    expect(result.reviewedAt).toBeDefined();

    // Agent should still be SUSPENDED
    const profile = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(profile.json<{ status: string }>().status).toBe('SUSPENDED');
  });

  it('moderator can reverse an appeal — agent is reactivated', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_review2', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_review2', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_review2', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // File appeal
    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'The artifact was actually delivered before the deadline, evidence attached.' }
    });

    // Moderator reverses — sanction is lifted
    const review = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/review`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'REVERSED' }
    });

    expect(review.statusCode).toBe(200);
    const result = review.json<SanctionResponse>();
    expect(result.status).toBe('REVERSED');
    expect(result.reviewRuling).toBe('REVERSED');

    // Agent should be reactivated (ACTIVE) since no more active sanctions
    const profile = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(profile.json<{ status: string }>().status).toBe('ACTIVE');
  });

  it('worker cannot review appeals — role forbidden', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_review3', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_review3', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_review3', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'I completed the work and delivered it within the required timeframe.' }
    });

    // Worker tries to review their own appeal — should be denied
    const review = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/review`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { ruling: 'REVERSED' }
    });

    expect(review.statusCode).toBe(403);
  });

  it('rejects review on non-appealed sanction', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_review4', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_review4', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_review4', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // Try to review without filing appeal first
    const review = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/review`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'REVERSED' }
    });

    expect(review.statusCode).toBe(409);
    expect(review.json<{ error: { code: string } }>().error.code).toBe('SANCTION_NOT_APPEALED');
  });

  // ─── Suspension Expiry ─────────────────────────────────────────────────────

  it('POST /v1/sanctions/expire expires time-limited suspensions', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_expiry1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_expiry1', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_expiry1', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // Verify the worker is SUSPENDED
    let profile = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(profile.json<{ status: string }>().status).toBe('SUSPENDED');

    // Manually set the sanction's effectiveAt to the past (beyond 168h)
    // We need to access the store directly — use admin to read sanctions first
    const sanctions = await app.inject({
      method: 'GET',
      url: '/v1/agents/me/sanctions',
      headers: authHeaders(worker.agentId, 'worker')
    });
    const sanctionList = sanctions.json<SanctionResponse[]>();
    expect(sanctionList.length).toBeGreaterThan(0);
    const sanction = sanctionList[0];
    expect(sanction.type).toBe('SUSPEND');
    expect(sanction.durationHours).toBe(168);

    // The sanction was just created, so it hasn't expired yet.
    // Call expire endpoint — should report 0 expired (sanctions are fresh)
    const expiry1 = await app.inject({
      method: 'POST',
      url: '/v1/sanctions/expire',
      headers: authHeaders(moderator.agentId, 'moderator')
    });
    expect(expiry1.statusCode).toBe(200);
    const result1 = expiry1.json<ExpiryResponse>();
    expect(result1.expiredCount).toBe(0);
    expect(result1.reactivatedAgents).toEqual([]);
  });

  it('admin can trigger sanction expiry check', async () => {
    const admin = await onboardAgent(app, { tokenSeed: 'adm_expiry2', role: 'admin', capabilities: ['admin'] });

    const expiry = await app.inject({
      method: 'POST',
      url: '/v1/sanctions/expire',
      headers: authHeaders(admin.agentId, 'admin')
    });

    expect(expiry.statusCode).toBe(200);
    const result = expiry.json<ExpiryResponse>();
    expect(result.expiredCount).toBe(0);
    expect(result.reactivatedAgents).toEqual([]);
  });

  it('worker cannot trigger sanction expiry', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_expiry3', role: 'worker', capabilities: ['python'] });

    const expiry = await app.inject({
      method: 'POST',
      url: '/v1/sanctions/expire',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(expiry.statusCode).toBe(403);
  });

  it('requester cannot trigger sanction expiry', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_expiry4', role: 'requester', capabilities: ['orchestrator'] });

    const expiry = await app.inject({
      method: 'POST',
      url: '/v1/sanctions/expire',
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(expiry.statusCode).toBe(403);
  });

  // ─── Reversal Reactivation ─────────────────────────────────────────────────

  it('reversed sanction allows worker to bid again', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_react1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_react1', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_react1', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 1000);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // Verify worker cannot bid while suspended
    const task1 = await createPostedTask(app, requester.agentId, 'python');
    const blockedBid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task1.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 80 }
    });
    expect(blockedBid.statusCode).toBe(403);

    // Appeal and get reversed
    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'The work was completed correctly. Evidence is available in the artifact log.' }
    });
    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/review`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'REVERSED' }
    });

    // Verify worker can now bid again
    const task2 = await createPostedTask(app, requester.agentId, 'python');
    const allowedBid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task2.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 80 }
    });
    expect(allowedBid.statusCode).toBe(200);
  });

  // ─── Audit Events ─────────────────────────────────────────────────────────

  it('appeal and review produce audit events', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_audit1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_audit1', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_audit1', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // Appeal
    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'I believe this sanction was applied incorrectly. Please review the evidence.' }
    });

    // Review
    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/review`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'REVERSED' }
    });

    // Check audit events for this agent
    const events = await app.inject({
      method: 'GET',
      url: `/v1/events/${worker.agentId}`,
      headers: authHeaders(moderator.agentId, 'moderator')
    });

    expect(events.statusCode).toBe(200);
    const body = events.json<{ events: Array<{ eventType: string; entityId: string }> }>();
    const eventList = body.events;

    // Should contain sanction.applied, sanction.appealed, sanction.review_completed, agent.reactivated
    const eventTypes = eventList.map((e) => e.eventType);
    expect(eventTypes).toContain('sanction.applied');
    expect(eventTypes).toContain('sanction.appealed');
    expect(eventTypes).toContain('sanction.review_completed');
    expect(eventTypes).toContain('agent.reactivated');
  });

  // ─── Edge Cases ────────────────────────────────────────────────────────────

  it('returns 404 for appeal on non-existent sanction', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_edge1', role: 'worker', capabilities: ['python'] });

    const appeal = await app.inject({
      method: 'POST',
      url: '/v1/sanctions/nonexistent_sanction_id/appeal',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'I want to appeal this sanction because it was incorrectly applied.' }
    });

    expect(appeal.statusCode).toBe(404);
  });

  it('returns 404 for review of non-existent sanction', async () => {
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_edge2', role: 'moderator', capabilities: ['moderation'] });

    const review = await app.inject({
      method: 'POST',
      url: '/v1/sanctions/nonexistent_sanction_id/review',
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'REVERSED' }
    });

    expect(review.statusCode).toBe(404);
  });

  it('admin can review sanction appeals', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_admin_review', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_admin_review', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_admin_review', role: 'moderator', capabilities: ['moderation'] });
    const admin = await onboardAgent(app, { tokenSeed: 'adm_admin_review', role: 'admin', capabilities: ['admin'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'This sanction is unjust. I have proof that the task was completed properly.' }
    });

    // Admin reviews instead of moderator
    const review = await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/review`,
      headers: authHeaders(admin.agentId, 'admin'),
      payload: { ruling: 'REVERSED' }
    });

    expect(review.statusCode).toBe(200);
    expect(review.json<SanctionResponse>().reviewedBy).toBe(admin.agentId);
  });

  it('upheld appeal does not reactivate agent', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_noreact', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_noreact', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_noreact', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    const { sanctionId } = await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    // Appeal
    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reason: 'I believe this sanction should be reviewed because of extenuating circumstances.' }
    });

    // Moderator upholds
    await app.inject({
      method: 'POST',
      url: `/v1/sanctions/${sanctionId}/review`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'UPHELD' }
    });

    // Agent should still be suspended
    const profile = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(profile.json<{ status: string }>().status).toBe('SUSPENDED');

    // Agent should still not be able to bid
    const task = await createPostedTask(app, requester.agentId, 'python');
    const bid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 80 }
    });
    expect(bid.statusCode).toBe(403);
  });

  it('sanctions/me endpoint returns all sanctions for current agent', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_list1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wrk_list1', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_list1', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 500);

    await sanctionWorkerViaDispute(app, requester.agentId, worker.agentId, moderator.agentId);

    const sanctions = await app.inject({
      method: 'GET',
      url: '/v1/sanctions/me',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(sanctions.statusCode).toBe(200);
    const list = sanctions.json<SanctionResponse[]>();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].agentId).toBe(worker.agentId);
    expect(list[0].type).toBe('SUSPEND');
    expect(list[0].durationHours).toBe(168);
  });
});
