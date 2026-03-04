/**
 * Dispute attack surface tests
 *
 * Adversarial tests for dispute operations:
 * - Non-contract-party trying to open dispute → NOT_CONTRACT_PARTY (403)
 * - Non-contract-party trying to appeal → NOT_CONTRACT_PARTY (403)
 * - Third-party viewing dispute → CONTRACT_FORBIDDEN (403)
 * - Third-party viewing dispute evidence → CONTRACT_FORBIDDEN (403)
 * - Appeal after 72-hour window is closed → APPEAL_WINDOW_CLOSED (409)
 * - Opening dispute on non-existent contract → CONTRACT_NOT_FOUND (404)
 * - Moderator CAN view any dispute (positive path)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../src/app.js';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

// -----------------------------------------------------------------------
// Local helper: creates a fully ASSIGNED contract (task accepted)
// -----------------------------------------------------------------------
async function createAssignedContract(
  app: FastifyInstance,
  requesterId: string,
  workerId: string
): Promise<{ contractId: string; taskId: string }> {
  const task = await createPostedTask(app, requesterId, 'python');

  const bid = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 80 }
  });
  if (bid.statusCode !== 200) throw new Error(`bid failed: ${bid.statusCode} ${bid.body}`);

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/reserve`,
    headers: authHeaders(workerId, 'worker')
  });
  if (reserve.statusCode !== 200) throw new Error(`reserve failed: ${reserve.statusCode} ${reserve.body}`);

  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  const accept = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });
  if (accept.statusCode !== 200) throw new Error(`accept failed: ${accept.statusCode} ${accept.body}`);

  const contract = accept.json<{ contractId: string }>();
  return { contractId: contract.contractId, taskId: task.taskId };
}

describe('dispute attack surface', () => {
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
  // Non-party open attacks
  // ------------------------------------------------------------------

  it('outsider cannot open dispute on a contract they are not party to', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'da_req_outsider_open',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'da_wrk_outsider_open',
      role: 'worker',
      capabilities: ['python']
    });
    const outsider = await onboardAgent(app, {
      tokenSeed: 'da_outsider_opener',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 200);
    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(outsider.agentId, 'requester'),
      payload: {
        contractId,
        reasonCode: 'NON_DELIVERY',
        againstAgentId: worker.agentId
      }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_CONTRACT_PARTY');
  });

  // ------------------------------------------------------------------
  // Non-party appeal attacks
  // ------------------------------------------------------------------

  it('outsider cannot appeal a dispute on a contract they are not party to', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'da_req_appeal_outsider',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'da_wrk_appeal_outsider',
      role: 'worker',
      capabilities: ['python']
    });
    const outsider = await onboardAgent(app, {
      tokenSeed: 'da_outsider_appealer',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 200);
    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

    // Open a dispute legitimately
    const openRes = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId,
        reasonCode: 'NON_DELIVERY',
        againstAgentId: worker.agentId
      }
    });
    expect(openRes.statusCode).toBe(200);
    const { disputeId } = openRes.json<{ disputeId: string }>();

    // Outsider tries to appeal
    const res = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/appeal`,
      headers: authHeaders(outsider.agentId, 'worker')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_CONTRACT_PARTY');
  });

  // ------------------------------------------------------------------
  // Third-party view attacks
  // ------------------------------------------------------------------

  it('outsider cannot view dispute details for a contract they are not party to', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'da_req_view_outsider',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'da_wrk_view_outsider',
      role: 'worker',
      capabilities: ['python']
    });
    const outsider = await onboardAgent(app, {
      tokenSeed: 'da_outsider_viewer',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 200);
    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

    const openRes = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId,
        reasonCode: 'NON_DELIVERY',
        againstAgentId: worker.agentId
      }
    });
    expect(openRes.statusCode).toBe(200);
    const { disputeId } = openRes.json<{ disputeId: string }>();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${disputeId}`,
      headers: authHeaders(outsider.agentId, 'requester')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CONTRACT_FORBIDDEN');
  });

  it('outsider cannot view dispute evidence for a contract they are not party to', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'da_req_evidence_outsider',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'da_wrk_evidence_outsider',
      role: 'worker',
      capabilities: ['python']
    });
    const outsider = await onboardAgent(app, {
      tokenSeed: 'da_outsider_evidence',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 200);
    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

    const openRes = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId,
        reasonCode: 'NON_DELIVERY',
        againstAgentId: worker.agentId
      }
    });
    expect(openRes.statusCode).toBe(200);
    const { disputeId } = openRes.json<{ disputeId: string }>();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${disputeId}/evidence`,
      headers: authHeaders(outsider.agentId, 'requester')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CONTRACT_FORBIDDEN');
  });

  // ------------------------------------------------------------------
  // Appeal window attacks
  // ------------------------------------------------------------------

  it('appeal after 72-hour window is APPEAL_WINDOW_CLOSED', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'da_req_deadline_appeal',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'da_wrk_deadline_appeal',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 200);
    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

    const openRes = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId,
        reasonCode: 'NON_DELIVERY',
        againstAgentId: worker.agentId
      }
    });
    expect(openRes.statusCode).toBe(200);
    const { disputeId } = openRes.json<{ disputeId: string }>();

    // Manually expire the appeal deadline in store (direct store manipulation)
    const dispute = services.store.disputes.get(disputeId)!;
    services.store.disputes.set(disputeId, {
      ...dispute,
      appealDeadlineAt: new Date(Date.now() - 1000).toISOString() // 1 second in the past
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/appeal`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('APPEAL_WINDOW_CLOSED');
  });

  // ------------------------------------------------------------------
  // Non-existent resource attacks
  // ------------------------------------------------------------------

  it('opening dispute against non-existent contract returns CONTRACT_NOT_FOUND', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'da_req_fake_contract',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId: 'contract_does_not_exist',
        reasonCode: 'NON_DELIVERY',
        againstAgentId: 'agent_fake'
      }
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('fetching non-existent dispute returns 404', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'da_req_get_fake_dispute',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/dispute_does_not_exist',
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(res.statusCode).toBe(404);
  });

  // ------------------------------------------------------------------
  // Moderator positive access (bypass check)
  // ------------------------------------------------------------------

  it('moderator can view any dispute without being a contract party', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'da_req_mod_view',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'da_wrk_mod_view',
      role: 'worker',
      capabilities: ['python']
    });
    const moderator = await onboardAgent(app, {
      tokenSeed: 'da_mod_view',
      role: 'moderator',
      capabilities: ['moderation']
    });

    await topup(app, requester.agentId, 'requester', 200);
    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);

    const openRes = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId,
        reasonCode: 'NON_DELIVERY',
        againstAgentId: worker.agentId
      }
    });
    expect(openRes.statusCode).toBe(200);
    const { disputeId } = openRes.json<{ disputeId: string }>();

    // Moderator views dispute — should succeed (no CONTRACT_FORBIDDEN)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${disputeId}`,
      headers: authHeaders(moderator.agentId, 'moderator')
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ disputeId: string }>().disputeId).toBe(disputeId);
  });
});
