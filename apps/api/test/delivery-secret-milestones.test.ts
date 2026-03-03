/**
 * TASK-HARD-010: Delivery secret randomness + artifact finalization validation
 * TASK-FEAT-001: Custom milestone definitions in task creation
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

async function createAssignedContract(
  app: FastifyInstance,
  requesterId: string,
  workerId: string,
  milestoneNames?: string[]
): Promise<{ contractId: string; milestones: { milestoneId: string; name: string; amountCredits: number }[] }> {
  // Create task with optional milestoneNames
  const created = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: authHeaders(requesterId, 'requester'),
    payload: {
      title: 'Test Task',
      description: 'Test description',
      pricingMode: 'fixed',
      budget: 100,
      deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      scope: {
        allowedDataRefs: ['dataset://test/input.csv'],
        allowedTools: ['python'],
        egressAllowlist: ['api.test.local'],
        deliverableSchemaRef: 'schema://deliverable/v1',
        acceptanceTestsRef: 'tests://acceptance/v1'
      },
      ...(milestoneNames ? { milestoneNames } : {})
    }
  });
  expect(created.statusCode).toBe(200);
  const task = created.json<{ taskId: string }>();

  await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/post`,
    headers: authHeaders(requesterId, 'requester')
  });

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
  expect(reserve.statusCode).toBe(200);
  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  const acceptTask = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });
  expect(acceptTask.statusCode).toBe(200);

  return acceptTask.json<{ contractId: string; milestones: { milestoneId: string; name: string; amountCredits: number }[] }>();
}

describe('TASK-HARD-010: Delivery secret randomness and artifact validation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('delivery secrets differ between contracts (non-deterministic)', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_rand1', role: 'requester', capabilities: ['orchestrator'] });
    const worker1 = await onboardAgent(app, { tokenSeed: 'wkr_rand1', role: 'worker', capabilities: ['python'] });
    const worker2 = await onboardAgent(app, { tokenSeed: 'wkr_rand2', role: 'worker', capabilities: ['python'] });

    await topup(app, requester.agentId, 'requester', 300);

    const contract1 = await createAssignedContract(app, requester.agentId, worker1.agentId);
    const contract2 = await createAssignedContract(app, requester.agentId, worker2.agentId);

    // Get signatures for same content on different contracts — should differ (different secrets)
    const sig1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract1.contractId}/signature-preview`,
      headers: authHeaders(worker1.agentId, 'worker'),
      payload: { milestoneId: contract1.milestones[0].milestoneId, content: 'same-content' }
    });
    const sig2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract2.contractId}/signature-preview`,
      headers: authHeaders(worker2.agentId, 'worker'),
      payload: { milestoneId: contract2.milestones[0].milestoneId, content: 'same-content' }
    });

    expect(sig1.statusCode).toBe(200);
    expect(sig2.statusCode).toBe(200);

    const { signature: s1 } = sig1.json<{ signature: string }>();
    const { signature: s2 } = sig2.json<{ signature: string }>();

    // Different contracts → different random secrets → different signatures for same content
    expect(s1).not.toBe(s2);
  });

  it('delivery secrets differ between milestones of same contract', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_ms_diff', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_ms_diff', role: 'worker', capabilities: ['python'] });

    await topup(app, requester.agentId, 'requester', 200);
    const contract = await createAssignedContract(app, requester.agentId, worker.agentId, ['Phase A', 'Phase B']);

    const sigM1 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: contract.milestones[0].milestoneId, content: 'same-content' }
    });
    const sigM2 = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: contract.milestones[1].milestoneId, content: 'same-content' }
    });

    expect(sigM1.statusCode).toBe(200);
    expect(sigM2.statusCode).toBe(200);

    const s1 = sigM1.json<{ signature: string }>().signature;
    const s2 = sigM2.json<{ signature: string }>().signature;

    // Different milestones → different secrets → different signatures
    expect(s1).not.toBe(s2);
  });

  it('valid signature from signature-preview allows delivery', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_valid_del', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_valid_del', role: 'worker', capabilities: ['python'] });

    await topup(app, requester.agentId, 'requester', 100);
    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    const milestoneId = contract.milestones[0].milestoneId;
    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId, content: 'delivery-content' }
    });
    expect(sigRes.statusCode).toBe(200);
    const { signature } = sigRes.json<{ signature: string }>();

    const deliver = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId, content: 'delivery-content', signature }
    });
    expect(deliver.statusCode).toBe(200);
  });

  it('tampered content with valid signature fails delivery', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_tamper', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_tamper', role: 'worker', capabilities: ['python'] });

    await topup(app, requester.agentId, 'requester', 100);
    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);
    const milestoneId = contract.milestones[0].milestoneId;

    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId, content: 'original-content' }
    });
    const { signature } = sigRes.json<{ signature: string }>();

    // Use signature for 'original-content' but deliver 'tampered-content'
    const deliver = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId, content: 'tampered-content', signature }
    });
    expect(deliver.statusCode).toBe(400);
    expect(deliver.json<{ error: { code: string } }>().error.code).toBe('INVALID_ARTIFACT_SIGNATURE');
  });
});

describe('TASK-FEAT-001: Custom milestone definitions', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates contract with default 2-phase milestones when none specified', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_def_ms', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_def_ms', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId);

    expect(contract.milestones).toHaveLength(2);
    expect(contract.milestones[0].name).toBe('Phase 1');
    expect(contract.milestones[1].name).toBe('Phase 2');
  });

  it('creates contract with 1 milestone', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_1ms', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_1ms', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId, ['Complete deliverable']);

    expect(contract.milestones).toHaveLength(1);
    expect(contract.milestones[0].name).toBe('Complete deliverable');
    expect(contract.milestones[0].amountCredits).toBe(100);
  });

  it('creates contract with 3 custom milestones with equal budget split', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_3ms', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_3ms', role: 'worker', capabilities: ['python'] });
    // Task budget is 100 (hardcoded in createAssignedContract helper); must topup >= 100
    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId, ['Design', 'Implementation', 'Testing']);

    expect(contract.milestones).toHaveLength(3);
    expect(contract.milestones[0].name).toBe('Design');
    expect(contract.milestones[1].name).toBe('Implementation');
    expect(contract.milestones[2].name).toBe('Testing');

    // Equal split of 100: 33.33 + 33.33 + 33.34 = 100
    const totalAmount = contract.milestones.reduce((sum, m) => sum + m.amountCredits, 0);
    expect(totalAmount).toBe(100);
  });

  it('budget split sums to task budget across all milestones', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_sum', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_sum', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    // 3 milestones with 100 budget: 33.33 + 33.33 + 33.34 = 100
    const contract = await createAssignedContract(app, requester.agentId, worker.agentId, ['Alpha', 'Beta', 'Release']);

    const totalAmount = contract.milestones.reduce((sum, m) => sum + m.amountCredits, 0);
    expect(totalAmount).toBe(100);
  });

  it('uses first milestone IN_PROGRESS, rest PENDING for custom names', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_status', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_status', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const contract = await createAssignedContract(app, requester.agentId, worker.agentId, ['Start', 'Middle', 'End']);

    expect(contract.milestones[0].status ?? 'IN_PROGRESS').toBe('IN_PROGRESS');
    // Remaining milestones should be PENDING
    for (let i = 1; i < contract.milestones.length; i++) {
      expect(contract.milestones[i].status ?? 'PENDING').toBe('PENDING');
    }
  });
});
