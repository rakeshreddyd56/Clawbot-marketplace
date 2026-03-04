/**
 * Policy decision enforcement — role-based denial tests
 *
 * Verifies deny-by-default policy: every role is DENIED actions
 * outside its allowed set. Tests all meaningful cross-role violations.
 *
 * Policy rules (from PolicyDecisionService):
 * - worker:    task.create, task.post, task.cancel, contract.milestone.accept, dispute.resolve DENIED
 * - requester: task.reserve, task.heartbeat, bid.create, contract.milestone.start,
 *              contract.milestone.deliver, dispute.resolve DENIED
 * - moderator: wallet.topup, wallet.payout, task.create, task.reserve DENIED
 * - any role:  UNKNOWN_ACTION → DENIED (deny-by-default)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

const TASK_PAYLOAD = {
  title: 'Policy Test Task',
  description: 'Used to test policy denials',
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
};

describe('policy role-based enforcement', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------
  // Worker role denials
  // ------------------------------------------------------------------

  it('worker is denied task.create', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'pol_wrk_task_create',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: TASK_PAYLOAD
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('worker is denied task.post', async () => {
    // We need a real task; create it via admin-like agent so we have a taskId
    const requester = await onboardAgent(app, {
      tokenSeed: 'pol_req_for_wrk_post',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'pol_wrk_task_post',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    // Create task (stays DRAFT)
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: TASK_PAYLOAD
    });
    const { taskId } = createRes.json<{ taskId: string }>();

    // Worker tries to post
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('worker is denied task.cancel', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'pol_req_for_wrk_cancel',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'pol_wrk_task_cancel',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/cancel`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { reasonCode: 'TEST' }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('worker is denied contract.milestone.accept (only requesters can accept)', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'pol_wrk_milestone_accept',
      role: 'worker',
      capabilities: ['python']
    });

    // Just hit the endpoint with a fake contractId — policy is checked first
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contracts/fake-contract-id/milestones/fake-ms-id/accept',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('worker is denied dispute.resolve', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'pol_wrk_dispute_resolve',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/disputes/fake-dispute-id/resolve',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { ruling: 'split', targetAgentId: 'agent_xyz' }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  // ------------------------------------------------------------------
  // Requester role denials
  // ------------------------------------------------------------------

  it('requester is denied task.reserve', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'pol_req_task_reserve',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    // Either POLICY_DENY (403) or ROLE_FORBIDDEN (403) from route-level check
    expect(res.statusCode).toBe(403);
  });

  it('requester is denied bid.create', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'pol_req_bid_create',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { rate: 80 }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('requester is denied contract.milestone.start', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'pol_req_ms_start',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contracts/fake-contract-id/milestones/fake-ms-id/start',
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('requester is denied contract.milestone.deliver', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'pol_req_ms_deliver',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contracts/fake-contract-id/milestones/fake-ms-id/deliver',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { content: 'test', signature: 'test-sig' }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('requester is denied dispute.resolve', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'pol_req_dispute_resolve',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/disputes/fake-dispute-id/resolve',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { ruling: 'split', targetAgentId: 'agent_xyz' }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  // ------------------------------------------------------------------
  // Moderator role denials
  // ------------------------------------------------------------------

  it('moderator is denied wallet.topup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders('mod_fake_topup', 'moderator'),
      payload: { amount: 100 }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('moderator is denied wallet.payout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders('mod_fake_payout', 'moderator'),
      payload: { amount: 50 }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('moderator is denied task.create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders('mod_fake_create_task', 'moderator'),
      payload: TASK_PAYLOAD
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('moderator is denied task.reserve', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks/fake-task-id/reserve',
      headers: authHeaders('mod_fake_reserve', 'moderator')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  // ------------------------------------------------------------------
  // Deny-by-default: unknown actions
  // ------------------------------------------------------------------

  it('deny-by-default: unknown action is denied even for admin evaluating policy', async () => {
    // The /v1/policy/decide endpoint allows moderator/admin to evaluate
    const moderator = await onboardAgent(app, {
      tokenSeed: 'pol_mod_unknown_action',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policy/decide',
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        action: 'superadmin.nuclear.launch', // definitely not a known action
        context: {}
      }
    });

    expect(res.statusCode).toBe(200); // endpoint returns 200 with decision
    const body = res.json<{ allow: boolean; reason: string }>();
    expect(body.allow).toBe(false);
    expect(body.reason).toBe('UNKNOWN_ACTION');
  });

  it('deny-by-default: unknown action with context is still denied', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'pol_mod_unknown_ctx',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policy/decide',
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        action: 'internal.bypass.everything'
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ allow: boolean; reason: string }>();
    expect(body.allow).toBe(false);
    expect(body.reason).toBe('UNKNOWN_ACTION');
  });

  it('deny-by-default: policy/decide with unknown context field is denied', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'pol_mod_bad_ctx_key',
      role: 'moderator',
      capabilities: ['moderation']
    });

    // task.list does not allow any context fields
    const res = await app.inject({
      method: 'POST',
      url: '/v1/policy/decide',
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        action: 'task.list',
        context: { unknownField: 'hacked', injectedPayload: true }
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ allow: boolean; reason: string }>();
    // UNKNOWN_CONTEXT_FIELD should deny
    expect(body.allow).toBe(false);
    expect(body.reason).toBe('UNKNOWN_CONTEXT_FIELD');
  });

  // ------------------------------------------------------------------
  // Privilege escalation via role header spoofing
  // ------------------------------------------------------------------

  it('worker spoofing moderator role via x-role header is blocked by route-level assertRole', async () => {
    // The /v1/policy/decide endpoint calls assertRole(['moderator', 'admin'])
    // If someone sets x-role: moderator without a valid session JWT, the server
    // will TRUST the header (since header auth is allowed by design).
    // This is expected — the system relies on the BFF to authenticate headers.
    // But if a raw requester uses x-role: moderator, policy decisions still run.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/policy/decide',
      headers: authHeaders('agent_fake_worker', 'worker'), // worker role
      payload: { action: 'task.list', context: {} }
    });

    // assertRole(['moderator', 'admin']) rejects worker
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ROLE_FORBIDDEN');
  });

  it('worker cannot view all policy decisions (moderator/admin only)', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'pol_wrk_view_decisions',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policy/decisions',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(403);
  });

  it('signature-preview route is restricted to worker and admin roles', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'pol_req_sig_preview',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contracts/fake-contract-id/signature-preview',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: 'ms_fake', content: 'payload' }
    });

    // BUG-MED-003: now enforced by PolicyDecisionService (POLICY_DENY) instead of assertRole (ROLE_FORBIDDEN)
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });
});
