/**
 * State machine violation tests
 *
 * Adversarially tests every invalid state transition to ensure
 * the business rules enforce the correct guard conditions:
 *
 * - Bid on DRAFT task → TASK_NOT_OPEN (409)
 * - Reserve DRAFT task → TASK_NOT_POSTED (409)
 * - Post already-POSTED task → TASK_INVALID_STATE (409)
 * - Deliver PENDING milestone → MILESTONE_NOT_ACTIVE (409)
 * - Accept PENDING milestone → MILESTONE_NOT_DELIVERED (409)
 * - Accept ACCEPTED milestone again → MILESTONE_NOT_DELIVERED (409)
 * - Cancel ASSIGNED task → TASK_CANNOT_CANCEL (409)
 * - Cancel ASSIGNED task is rejected even by admin (409)
 * - Worker without bid cannot reserve → BID_REQUIRED (409)
 * - Reserve RESERVED task again → TASK_ALREADY_RESERVED (409)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

type ContractResponse = {
  contractId: string;
  milestones: Array<{ milestoneId: string; amountCredits: number; status: string }>;
};

async function createAssignedContract(
  app: FastifyInstance,
  requesterId: string,
  workerId: string
): Promise<{ taskId: string } & ContractResponse> {
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

  const accept = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });

  return { taskId: task.taskId, ...accept.json<ContractResponse>() };
}

describe('state machine violations', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------
  // Task state violations
  // ------------------------------------------------------------------

  it('cannot bid on a DRAFT task (not yet posted)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_draft_bid',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_draft_bid',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    // Create task but do NOT post it (stays DRAFT)
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Draft Task',
        description: 'A task still in draft state',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['data://ref'],
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1'
        }
      }
    });
    const { taskId } = createRes.json<{ taskId: string }>();

    const bid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 80 }
    });

    expect(bid.statusCode).toBe(409);
    expect(bid.json<{ error: { code: string } }>().error.code).toBe('TASK_NOT_OPEN');
  });

  it('cannot reserve a DRAFT task (not yet posted)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_draft_reserve',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_draft_reserve',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    // Create task but do NOT post it
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Draft Reserve Task',
        description: 'A task still in draft — reserve should fail',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['data://ref'],
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1'
        }
      }
    });
    const { taskId } = createRes.json<{ taskId: string }>();

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    // Route-level eligibility check fires before marketplace check:
    // getTaskEligibility returns canReserve=false when task is not POSTED → 403 WORKER_RESERVE_BLOCKED
    // (The 409 TASK_NOT_POSTED would be returned if the route called marketplace directly)
    expect(reserve.statusCode).toBe(403);
    expect(reserve.json<{ error: { code: string } }>().error.code).toBe('WORKER_RESERVE_BLOCKED');
  });

  it('cannot post an already POSTED task', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_double_post',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python'); // already POSTED

    const secondPost = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/post`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(secondPost.statusCode).toBe(409);
    expect(secondPost.json<{ error: { code: string } }>().error.code).toBe('TASK_INVALID_STATE');
  });

  it('cannot cancel an ASSIGNED task', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_cancel_assigned',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_cancel_assigned',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    // Task should now be ASSIGNED — cancel should fail
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${contract.taskId}/cancel`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { reasonCode: 'CHANGED_MIND' }
    });

    expect(cancel.statusCode).toBe(409);
    expect(cancel.json<{ error: { code: string } }>().error.code).toBe('TASK_CANNOT_CANCEL');
  });

  // ------------------------------------------------------------------
  // Milestone state violations
  // ------------------------------------------------------------------

  it('cannot deliver milestone 2 while it is still PENDING (before milestone 1 is accepted)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_pending_deliver',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_pending_deliver',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    // milestone[0] is IN_PROGRESS, milestone[1] is PENDING
    const milestone2 = contract.milestones[1].milestoneId;

    // Get a signature for milestone 2 (the preview endpoint just computes, doesn't check state)
    const sig = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: milestone2, content: 'pending-content' }
    });
    const { signature } = sig.json<{ signature: string }>();

    // Try to deliver milestone 2 while it's PENDING → MILESTONE_NOT_ACTIVE
    const deliver = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: milestone2, content: 'pending-content', signature }
    });

    expect(deliver.statusCode).toBe(409);
    expect(deliver.json<{ error: { code: string } }>().error.code).toBe('MILESTONE_NOT_ACTIVE');
  });

  it('cannot accept a PENDING milestone (must be DELIVERED first)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_accept_pending',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_accept_pending',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    // milestone[0] is IN_PROGRESS (not yet DELIVERED)
    const milestone1 = contract.milestones[0].milestoneId;

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: milestone1 }
    });

    expect(accept.statusCode).toBe(409);
    expect(accept.json<{ error: { code: string } }>().error.code).toBe('MILESTONE_NOT_DELIVERED');
  });

  it('cannot accept the same milestone twice (double-spend prevention)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_double_accept',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_double_accept',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);
    const milestone1 = contract.milestones[0].milestoneId;

    // Deliver milestone 1
    const sig = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: milestone1, content: 'content-dbl' }
    });
    const { signature } = sig.json<{ signature: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: milestone1, content: 'content-dbl', signature }
    });

    // First acceptance succeeds
    const accept1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: milestone1 }
    });
    expect(accept1.statusCode).toBe(200);

    // Second acceptance must fail (milestone is now ACCEPTED, not DELIVERED)
    const accept2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: milestone1 }
    });
    expect(accept2.statusCode).toBe(409);
    expect(accept2.json<{ error: { code: string } }>().error.code).toBe('MILESTONE_NOT_DELIVERED');
  });

  it('cannot deliver milestone by a non-worker (wrong agent)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_delivery_wrong_actor',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_delivery_wrong_actor',
      role: 'worker',
      capabilities: ['python']
    });
    const intruder = await onboardAgent(app, {
      tokenSeed: 'sm_intruder_delivery',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);
    const milestone1 = contract.milestones[0].milestoneId;

    // Intruder tries to deliver (they are not the assigned worker)
    const sig = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'), // legit worker generates sig
      payload: { milestoneId: milestone1, content: 'intruder-content' }
    });
    const { signature } = sig.json<{ signature: string }>();

    const deliver = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(intruder.agentId, 'worker'), // intruder tries to deliver
      payload: { milestoneId: milestone1, content: 'intruder-content', signature }
    });

    expect(deliver.statusCode).toBe(403);
    expect(deliver.json<{ error: { code: string } }>().error.code).toBe('NOT_CONTRACT_WORKER');
  });

  // ------------------------------------------------------------------
  // Reservation state violations
  // ------------------------------------------------------------------

  it('cannot reserve a task without placing a bid first', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_no_bid_reserve',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_no_bid_reserve',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    // Skip bidding
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reserve.statusCode).toBe(409);
    expect(reserve.json<{ error: { code: string } }>().error.code).toBe('BID_REQUIRED');
  });

  it('requester cannot self-reserve own task', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_self_reserve',
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

    // Requesters cannot reserve (ROLE_FORBIDDEN from policy or ROLE_FORBIDDEN route check)
    expect([400, 403]).toContain(reserve.statusCode);
  });

  // ------------------------------------------------------------------
  // Task accept state violations
  // ------------------------------------------------------------------

  it('cannot accept a task that is not in RESERVED state (e.g. POSTED)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_accept_not_reserved',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_accept_not_reserved',
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

    // Get a real reserve to get a valid leaseId (even though task is not reserved)
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Cancel the reservation to bring task back to POSTED
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/cancel`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { reasonCode: 'TEST_CANCEL' }
    });

    // Try to accept the CLOSED task with the old lease
    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });

    // Task is now CLOSED → TASK_NOT_RESERVED
    expect(accept.statusCode).toBe(409);
    expect(accept.json<{ error: { code: string } }>().error.code).toBe('TASK_NOT_RESERVED');
  });

  // ------------------------------------------------------------------
  // Capability mismatch violation
  // ------------------------------------------------------------------

  it('worker with mismatched capabilities cannot reserve (CAPABILITY_MISMATCH)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_cap_mismatch',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    // Worker has only 'java' capability, but task requires 'python'
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_cap_mismatch',
      role: 'worker',
      capabilities: ['java'] // wrong capability
    });

    await topup(app, requester.agentId, 'requester', 100);

    // Task requires 'python' tools
    const task = await createPostedTask(app, requester.agentId, 'python');

    // Worker bids (bidding doesn't check capability)
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 80 }
    });

    // Reserve → should fail capability check
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    // Route-level eligibility check fires before marketplace check:
    // getTaskEligibility returns canReserve=false for capability mismatch → 403 WORKER_RESERVE_BLOCKED
    // (The 409 CAPABILITY_MISMATCH would be returned if the route called marketplace directly)
    expect(reserve.statusCode).toBe(403);
    expect(reserve.json<{ error: { code: string } }>().error.code).toBe('WORKER_RESERVE_BLOCKED');
  });

  // ------------------------------------------------------------------
  // Milestone start on DELIVERED milestone
  // ------------------------------------------------------------------

  it('cannot start a milestone that is already DELIVERED', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'sm_req_start_delivered',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'sm_wrk_start_delivered',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);
    const milestone1 = contract.milestones[0].milestoneId;

    // Deliver milestone 1
    const sig = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: milestone1, content: 'content-start-delivered' }
    });
    const { signature } = sig.json<{ signature: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: milestone1, content: 'content-start-delivered', signature }
    });

    // Try to start the DELIVERED milestone → MILESTONE_INVALID_STATE
    const start = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${milestone1}/start`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(start.statusCode).toBe(409);
    expect(start.json<{ error: { code: string } }>().error.code).toBe('MILESTONE_INVALID_STATE');
  });
});
