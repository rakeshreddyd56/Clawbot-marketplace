import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent } from './helpers.js';

describe('v1 plan API parity', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('supports onboarding aliases, nested milestone routes, artifacts, vault tokens, and payments webhook', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/v1/agents/onboarding/start'
    });

    expect(start.statusCode).toBe(200);

    const requesterVerify = await app.inject({
      method: 'POST',
      url: '/v1/agents/onboarding/verify-moltbook',
      payload: {
        identityToken: 'mbtok_requester_parity',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(requesterVerify.statusCode).toBe(200);
    const requesterId = requesterVerify.json<{ agentId: string }>().agentId;

    const requesterCap = await app.inject({
      method: 'POST',
      url: '/v1/agents/onboarding/capabilities',
      headers: authHeaders(requesterId, 'requester'),
      payload: {
        capabilities: ['orchestrator'],
        maxConcurrency: 3,
        dataClassesAllowed: ['public'],
        toolClassesAllowed: ['read', 'write']
      }
    });

    expect(requesterCap.statusCode).toBe(200);

    const requesterConstitution = await app.inject({
      method: 'POST',
      url: '/v1/agents/onboarding/accept-constitution',
      headers: authHeaders(requesterId, 'requester'),
      payload: {
        constitutionVersion: 'v1'
      }
    });

    expect(requesterConstitution.statusCode).toBe(200);

    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_parity',
      role: 'worker',
      capabilities: ['python'],
      maxConcurrency: 2
    });

    const moderator = await onboardAgent(app, {
      tokenSeed: 'moderator_parity',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const topup = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topups',
      headers: authHeaders(requesterId, 'requester'),
      payload: { amount: 120 }
    });

    expect(topup.statusCode).toBe(200);

    const createTask = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requesterId, 'requester'),
      payload: {
        title: 'Parity Task',
        description: 'Complete parity route validation',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['vault://tenant-a/input.csv'],
          allowedTools: ['python'],
          egressAllowlist: ['api.tenant-a.local'],
          deliverableSchemaRef: 'schema://deliverable/v1',
          acceptanceTestsRef: 'tests://acceptance/v1'
        }
      }
    });

    expect(createTask.statusCode).toBe(200);
    const taskId = createTask.json<{ taskId: string }>().taskId;

    const postTask = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: authHeaders(requesterId, 'requester')
    });

    expect(postTask.statusCode).toBe(200);

    const listTasks = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(listTasks.statusCode).toBe(200);
    expect(listTasks.json<{ tasks: Array<{ taskId: string }> }>().tasks.some((item) => item.taskId === taskId)).toBe(true);

    const bid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 }
    });

    expect(bid.statusCode).toBe(200);

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reserve.statusCode).toBe(200);
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const vaultToken = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/vault-token`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId: lease.leaseId,
        leaseToken: lease.leaseToken,
        dataRef: 'vault://tenant-a/input.csv'
      }
    });

    expect(vaultToken.statusCode).toBe(200);
    expect(vaultToken.json<{ vaultToken: string }>().vaultToken.length).toBeGreaterThan(8);

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/accept`,
      headers: authHeaders(requesterId, 'requester'),
      payload: lease
    });

    expect(accept.statusCode).toBe(200);

    const contract = accept.json<{ contractId: string; milestones: { milestoneId: string }[] }>();
    const milestoneId = contract.milestones[0].milestoneId;

    const startMilestone = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${milestoneId}/start`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(startMilestone.statusCode).toBe(200);

    const uploadUrl = await app.inject({
      method: 'POST',
      url: '/v1/artifacts/upload-url',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        contractId: contract.contractId,
        milestoneId,
        fileName: 'deliverable.json'
      }
    });

    expect(uploadUrl.statusCode).toBe(200);
    const upload = uploadUrl.json<{ artifactId: string; finalizeToken: string }>();

    const finalize = await app.inject({
      method: 'POST',
      url: `/v1/artifacts/${upload.artifactId}/finalize`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        sha256: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd',
        signature: 'signed-payload-123456',
        finalizeToken: upload.finalizeToken
      }
    });

    expect(finalize.statusCode).toBe(200);
    expect(finalize.json<{ validationStatus: string }>().validationStatus).toBe('VALID');

    const signature = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId,
        content: 'artifact-content-1'
      }
    });

    expect(signature.statusCode).toBe(200);
    const signed = signature.json<{ signature: string }>().signature;

    const deliver = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${milestoneId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        content: 'artifact-content-1',
        signature: signed,
        artifactId: upload.artifactId
      }
    });

    expect(deliver.statusCode).toBe(200);

    const acceptMilestone = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${milestoneId}/accept`,
      headers: authHeaders(requesterId, 'requester')
    });

    expect(acceptMilestone.statusCode).toBe(200);

    const reputation = await app.inject({
      method: 'GET',
      url: `/v1/reputation/${worker.agentId}`,
      headers: authHeaders(requesterId, 'requester')
    });

    expect(reputation.statusCode).toBe(200);
    expect(reputation.json<{ score: number }>().score).toBeGreaterThan(0);

    const webhook = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      payload: {
        type: 'payment_intent.succeeded',
        data: {
          id: 'pi_test_1'
        }
      }
    });

    expect(webhook.statusCode).toBe(200);
    expect(webhook.json<{ action: string }>().action).toBe('topup_confirmed');

    const newTask = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requesterId, 'requester'),
      payload: {
        title: 'Cancel Me',
        description: 'Task to cancel',
        pricingMode: 'fixed',
        budget: 10,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['vault://tenant-a/another.csv'],
          allowedTools: ['python'],
          egressAllowlist: ['api.tenant-a.local'],
          deliverableSchemaRef: 'schema://deliverable/v1',
          acceptanceTestsRef: 'tests://acceptance/v1'
        }
      }
    });

    const cancelTaskId = newTask.json<{ taskId: string }>().taskId;

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${cancelTaskId}/cancel`,
      headers: authHeaders(requesterId, 'requester'),
      payload: {
        reasonCode: 'NO_LONGER_NEEDED'
      }
    });

    expect(cancel.statusCode).toBe(200);
    expect(cancel.json<{ status: string }>().status).toBe('CLOSED');

    const policyDecisions = await app.inject({
      method: 'GET',
      url: '/v1/policy/decisions',
      headers: authHeaders(moderator.agentId, 'moderator')
    });

    expect(policyDecisions.statusCode).toBe(200);
    expect(policyDecisions.json<{ decisions: unknown[] }>().decisions.length).toBeGreaterThan(0);
  });
});
