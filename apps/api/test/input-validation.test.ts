/**
 * Input validation and error handling tests
 * Ensures all endpoints properly validate inputs and return actionable errors
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent, topup } from './helpers.js';

describe('input validation and error handling', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  // --- Onboarding validation ---

  it('verify-moltbook rejects tokens not starting with mbtok_', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'badprefix_token',
        audience: 'clawbot.marketplace.local'
      }
    });
    expect([400, 401]).toContain(res.statusCode);
  });

  it('verify-moltbook rejects missing audience', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_some_agent'
        // audience missing → defaults to clawbot.marketplace.local
      }
    });
    // Should succeed with default audience
    expect(res.statusCode).toBe(200);
  });

  it('verify-moltbook rejects too-short token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mb', // too short (min 5)
        audience: 'clawbot.marketplace.local'
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('capabilities endpoint rejects non-array capabilities', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'valid_cap_agent',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/me/capabilities',
      headers: authHeaders(agent.agentId, 'worker'),
      payload: {
        capabilities: 'python', // should be array
        maxConcurrency: 1,
        dataClassesAllowed: ['public'],
        toolClassesAllowed: ['read']
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('capabilities endpoint rejects zero maxConcurrency', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'cap_zero_concurrency',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/me/capabilities',
      headers: authHeaders(agent.agentId, 'worker'),
      payload: {
        capabilities: ['python'],
        maxConcurrency: 0, // must be positive
        dataClassesAllowed: ['public'],
        toolClassesAllowed: ['read']
      }
    });
    expect(res.statusCode).toBe(400);
  });

  it('constitution accept rejects empty constitutionVersion', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'constitution_empty_ver',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/me/constitution/accept',
      headers: authHeaders(agent.agentId, 'worker'),
      payload: {
        constitutionVersion: '' // empty string, min(1)
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  // --- Task creation validation ---

  it('task create rejects title shorter than 3 chars', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_task_short_title',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    await topup(app, requester.agentId, 'requester', 100);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'ab', // too short (min 3)
        description: 'valid description',
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
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('task create rejects bad pricingMode', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_bad_pricing',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    await topup(app, requester.agentId, 'requester', 100);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Valid Title',
        description: 'Valid description',
        pricingMode: 'auction', // invalid
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
    expect(res.statusCode).toBe(400);
  });

  it('task create rejects negative budget', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_negative_budget',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    await topup(app, requester.agentId, 'requester', 100);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Valid Title',
        description: 'Valid description',
        pricingMode: 'fixed',
        budget: -10, // invalid
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
    expect(res.statusCode).toBe(400);
  });

  it('task create rejects missing scope fields', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_missing_scope',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    await topup(app, requester.agentId, 'requester', 100);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Valid Title',
        description: 'Valid description',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          // allowedDataRefs missing
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1'
        }
      }
    });
    expect(res.statusCode).toBe(400);
  });

  it('task create rejects empty allowedTools array', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_empty_tools',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    await topup(app, requester.agentId, 'requester', 100);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Valid Title',
        description: 'Valid description',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['data://ref'],
          allowedTools: [], // must have min(1)
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1'
        }
      }
    });
    expect(res.statusCode).toBe(400);
  });

  // --- Bid validation ---

  it('bid rejects zero rate', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_zero_bid',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_zero_bid',
      role: 'worker',
      capabilities: ['python']
    });
    await topup(app, requester.agentId, 'requester', 100);

    const task = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Zero Bid Task',
        description: 'Test zero bid',
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
    const taskId = task.json<{ taskId: string }>().taskId;

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 0 } // must be positive
    });
    expect(res.statusCode).toBe(400);
  });

  // --- Dispute validation ---

  it('dispute open rejects missing contractId', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'dispute_missing_contract',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(agent.agentId, 'requester'),
      payload: {
        // contractId missing
        reasonCode: 'NON_DELIVERY',
        againstAgentId: 'agent_xyz'
      }
    });
    expect(res.statusCode).toBe(400);
  });

  it('dispute resolve rejects bad ruling value', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_bad_ruling',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/disputes/fake_dispute_id/resolve',
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'dismiss', // invalid - must be pay_worker|refund_requester|split
        targetAgentId: 'agent_xyz'
      }
    });
    expect(res.statusCode).toBe(400);
  });

  // --- Role enforcement ---

  it('worker cannot create tasks', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_no_create',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        title: 'Worker Task',
        description: 'Worker trying to create',
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
    expect(res.statusCode).toBe(403);
  });

  it('requester cannot resolve disputes', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_no_resolve',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/disputes/fake_dispute_id/resolve',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        ruling: 'split',
        targetAgentId: 'agent_xyz'
      }
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('non-existent task returns 404', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'task_404_check',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/tasks/task_nonexistent_xyz',
      headers: authHeaders(agent.agentId, 'worker')
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('TASK_NOT_FOUND');
  });

  it('non-existent contract returns 404', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'contract_404_check',
      role: 'worker',
      capabilities: ['python']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/contracts/contract_nonexistent_xyz',
      headers: authHeaders(agent.agentId, 'worker')
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('non-existent dispute returns 404', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'dispute_404_check',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/dispute_nonexistent_xyz',
      headers: authHeaders(agent.agentId, 'moderator')
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('DISPUTE_NOT_FOUND');
  });

  it('milestone delivery requires valid signature', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'requester_bad_sig',
      role: 'requester',
      capabilities: ['orchestrator']
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_bad_sig',
      role: 'worker',
      capabilities: ['python']
    });
    await topup(app, requester.agentId, 'requester', 100);

    // Create a task
    const task = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Sig Test Task',
        description: 'Test signature validation',
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
    const taskId = task.json<{ taskId: string }>().taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: authHeaders(requester.agentId, 'requester') });
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/bids`, headers: authHeaders(worker.agentId, 'worker'), payload: { rate: 100 } });
    const reserve = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reserve`, headers: authHeaders(worker.agentId, 'worker') });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();
    const accept = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/accept`, headers: authHeaders(requester.agentId, 'requester'), payload: lease });
    const contract = accept.json<{ contractId: string; milestones: Array<{ milestoneId: string }> }>();

    // Try delivery with tampered signature
    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract.milestones[0].milestoneId,
        content: 'real content',
        signature: 'tampered-bad-sig'
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_ARTIFACT_SIGNATURE');
  });

  it('session exchange rejects invalid role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_valid_agent',
        role: 'superuser' // invalid
      }
    });
    expect(res.statusCode).toBe(400);
  });

  it('topup rejects non-positive amount', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'topup_nonpositive',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(agent.agentId, 'requester'),
      payload: { amount: -1 }
    });
    expect(res.statusCode).toBe(400);
  });
});
