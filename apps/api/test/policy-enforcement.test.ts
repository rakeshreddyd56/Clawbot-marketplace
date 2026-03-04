import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

describe('BUG-MED-003: policy enforcement on previously-missing routes', () => {
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

  it('records policy decision for GET /v1/tasks/:taskId/eligibility', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_elig',
      role: 'worker',
      capabilities: ['python']
    });

    const requester = await onboardAgent(app, {
      tokenSeed: 'req_elig',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/eligibility`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(200);

    const decisions = policyDecisionsFor('task.eligibility.read');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].allow).toBe(true);
    expect(decisions[0].reason).toBe('ALLOW');
  });

  it('denies task.eligibility.read for requester role', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_elig_deny',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/eligibility`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('records policy decision for POST /v1/tasks/:taskId/accept', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_accept',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_accept',
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

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });

    expect(res.statusCode).toBe(200);

    const decisions = policyDecisionsFor('task.accept');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].allow).toBe(true);
    expect(decisions[0].reason).toBe('ALLOW');
  });

  it('denies task.accept for worker role', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_accept_deny',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_accept_deny',
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

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Worker should NOT be able to accept — only requester can
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: lease
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('records policy decision for GET /v1/disputes/:disputeId', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_dispute_read',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_dispute_read',
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

    const dispute = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'QUALITY_ISSUE',
        againstAgentId: worker.agentId
      }
    });

    expect(dispute.statusCode).toBe(200);
    const { disputeId } = dispute.json<{ disputeId: string }>();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${disputeId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(res.statusCode).toBe(200);

    const decisions = policyDecisionsFor('dispute.read');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].allow).toBe(true);
  });

  it('records policy decision for GET /v1/disputes/:disputeId/evidence', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_evidence',
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

    const dispute = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId: contract.contractId,
        reasonCode: 'QUALITY_ISSUE',
        againstAgentId: worker.agentId
      }
    });

    const { disputeId } = dispute.json<{ disputeId: string }>();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${disputeId}/evidence`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(res.statusCode).toBe(200);

    const decisions = policyDecisionsFor('dispute.evidence.read');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].allow).toBe(true);
  });

  it('records policy decision for POST /v1/contracts/:contractId/signature-preview', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_sigprev',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_sigprev',
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

    const contract = accept.json<{ contractId: string; milestones: { milestoneId: string }[] }>();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract.milestones[0].milestoneId,
        content: 'test-content'
      }
    });

    expect(res.statusCode).toBe(200);

    const decisions = policyDecisionsFor('artifact.signature.preview');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].allow).toBe(true);
  });

  it('denies artifact.signature.preview for requester role', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_sigprev_deny',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_sigprev_deny',
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

    const contract = accept.json<{ contractId: string; milestones: { milestoneId: string }[] }>();

    // Requester should NOT be able to preview signatures — only worker can
    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        milestoneId: contract.milestones[0].milestoneId,
        content: 'test-content'
      }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('records policy decision for POST /v1/tasks/:taskId/vault-token', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_vault',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_vault',
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

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/vault-token`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: lease.leaseToken,
        dataRef: 'dataset://tenant-a/input.csv'
      }
    });

    expect(res.statusCode).toBe(200);

    const decisions = policyDecisionsFor('vault.token.create');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].allow).toBe(true);
    expect(decisions[0].reason).toBe('ALLOW');
  });

  it('denies vault.token.create for requester role', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'req_vault_deny',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/vault-token`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        leaseId: 'fake-lease-id',
        leaseToken: 'fake-lease-token',
        dataRef: 'dataset://test/data.csv'
      }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('POLICY_DENY');
  });

  it('denies unknown actions (deny-by-default preserved)', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_unknown',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policy/decide',
      headers: authHeaders(worker.agentId, 'admin'),
      payload: {
        action: 'completely.unknown.action'
      }
    });

    expect(res.statusCode).toBe(200);
    const decision = res.json<{ allow: boolean; reason: string }>();
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('UNKNOWN_ACTION');
  });
});
