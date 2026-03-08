import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

/**
 * Helper: create a full contract (posted task → bid → reserve → accept)
 * and return { contractId, milestoneId } for the first milestone.
 */
async function createAssignedContract(
  app: FastifyInstance,
  requesterId: string,
  workerId: string
): Promise<{ contractId: string; milestoneId: string }> {
  const task = await createPostedTask(app, requesterId, 'python');

  await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 100 }
  });

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/reserve`,
    headers: authHeaders(workerId, 'worker')
  });

  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  const acceptRes = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });

  const contract = acceptRes.json<{ contractId: string; milestones: { milestoneId: string }[] }>();
  return { contractId: contract.contractId, milestoneId: contract.milestones[0].milestoneId };
}

/**
 * Helper: get a valid delivery signature for content on a given contract/milestone.
 */
async function getSignature(
  app: FastifyInstance,
  contractId: string,
  milestoneId: string,
  content: string,
  workerId: string
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/contracts/${contractId}/signature-preview`,
    headers: authHeaders(workerId, 'worker'),
    payload: { milestoneId, content }
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ signature: string }>().signature;
}

describe('TASK-ENFORCE-005: double-claim artifact detection', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects same artifact content delivered to a different contract (cross-contract duplicate)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_dc1',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'wrk_dc1',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 5
    });

    await topup(app, requester.agentId, 'requester', 500);

    // Create two separate contracts
    const contract1 = await createAssignedContract(app, requester.agentId, worker.agentId);
    const contract2 = await createAssignedContract(app, requester.agentId, worker.agentId);

    const duplicateContent = 'identical-artifact-content-for-both-contracts';

    // Deliver to contract 1 — should succeed
    const sig1 = await getSignature(app, contract1.contractId, contract1.milestoneId, duplicateContent, worker.agentId);
    const deliver1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract1.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract1.milestoneId,
        content: duplicateContent,
        signature: sig1
      }
    });
    expect(deliver1.statusCode).toBe(200);

    // Deliver same content to contract 2 — should be rejected as DUPLICATE_ARTIFACT
    const sig2 = await getSignature(app, contract2.contractId, contract2.milestoneId, duplicateContent, worker.agentId);
    const deliver2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract2.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract2.milestoneId,
        content: duplicateContent,
        signature: sig2
      }
    });

    expect(deliver2.statusCode).toBe(409);
    expect(deliver2.json<{ error: { code: string } }>().error.code).toBe('DUPLICATE_ARTIFACT');
  });

  it('allows re-delivery of same content within the same contract (same-contract re-delivery)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_dc2',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'wrk_dc2',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 5
    });

    await topup(app, requester.agentId, 'requester', 500);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    const content = 'artifact-content-same-contract';

    // First delivery — should succeed
    const sig1 = await getSignature(app, contract.contractId, contract.milestoneId, content, worker.agentId);
    const deliver1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract.milestoneId,
        content,
        signature: sig1
      }
    });
    expect(deliver1.statusCode).toBe(200);

    // The milestone is now DELIVERED, so a re-delivery to the same milestone
    // would fail with MILESTONE_NOT_ACTIVE (not DUPLICATE_ARTIFACT),
    // which proves same-contract content is not treated as duplicate.
    const sig2 = await getSignature(app, contract.contractId, contract.milestoneId, content, worker.agentId);
    const deliver2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract.milestoneId,
        content,
        signature: sig2
      }
    });

    // Should NOT be DUPLICATE_ARTIFACT — milestone state check fires first
    expect(deliver2.statusCode).toBe(409);
    expect(deliver2.json<{ error: { code: string } }>().error.code).toBe('MILESTONE_NOT_ACTIVE');
  });

  it('emits violation.double_claim_detected audit event on duplicate', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_dc3',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'wrk_dc3',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 5
    });

    await topup(app, requester.agentId, 'requester', 500);

    const contract1 = await createAssignedContract(app, requester.agentId, worker.agentId);
    const contract2 = await createAssignedContract(app, requester.agentId, worker.agentId);

    const duplicateContent = 'duplicate-audit-check-content';

    // Deliver to contract 1
    const sig1 = await getSignature(app, contract1.contractId, contract1.milestoneId, duplicateContent, worker.agentId);
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract1.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract1.milestoneId,
        content: duplicateContent,
        signature: sig1
      }
    });

    // Attempt duplicate delivery to contract 2
    const sig2 = await getSignature(app, contract2.contractId, contract2.milestoneId, duplicateContent, worker.agentId);
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract2.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract2.milestoneId,
        content: duplicateContent,
        signature: sig2
      }
    });

    // Check audit events for violation.double_claim_detected
    const events = await app.inject({
      method: 'GET',
      url: `/v1/events/${contract2.contractId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(events.statusCode).toBe(200);
    const { events: eventList } = events.json<{ events: { eventType: string; payload: Record<string, unknown> }[] }>();
    const violationEvent = eventList.find((e) => e.eventType === 'violation.double_claim_detected');
    expect(violationEvent).toBeDefined();
    expect(violationEvent!.payload.workerAgentId).toBe(worker.agentId);
    expect(violationEvent!.payload.newContractId).toBe(contract2.contractId);
  });

  it('allows different content to be delivered to different contracts', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_dc4',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'wrk_dc4',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 5
    });

    await topup(app, requester.agentId, 'requester', 500);

    const contract1 = await createAssignedContract(app, requester.agentId, worker.agentId);
    const contract2 = await createAssignedContract(app, requester.agentId, worker.agentId);

    // Deliver unique content to contract 1
    const content1 = 'unique-artifact-for-contract-1';
    const sig1 = await getSignature(app, contract1.contractId, contract1.milestoneId, content1, worker.agentId);
    const deliver1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract1.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract1.milestoneId,
        content: content1,
        signature: sig1
      }
    });
    expect(deliver1.statusCode).toBe(200);

    // Deliver different content to contract 2 — should succeed
    const content2 = 'unique-artifact-for-contract-2';
    const sig2 = await getSignature(app, contract2.contractId, contract2.milestoneId, content2, worker.agentId);
    const deliver2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract2.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract2.milestoneId,
        content: content2,
        signature: sig2
      }
    });
    expect(deliver2.statusCode).toBe(200);
  });
});
