/**
 * TASK-TEST-002: Full integration tests for task lifecycle
 *
 * Covers the full task lifecycle from creation through completion:
 * - DRAFT → POSTED transition
 * - Public task listing (no auth required)
 * - Multiple bids on same task
 * - Bid visibility: only requester/admin/moderator can see bids
 * - POSTED → RESERVED → ASSIGNED flow
 * - Custom milestone names in task creation
 * - Task scope access via lease
 * - Vault token issuance with valid/invalid data refs
 * - Milestone start → deliver → accept full path
 * - Reputation update after successful milestone delivery
 * - Task cancel in DRAFT and POSTED states
 * - Task ownership enforcement (only requester can post/cancel their task)
 * - Concurrent bidding from multiple workers
 * - Non-existent task/contract 404 handling
 * - Signature preview → delivery flow
 * - Artifact upload URL → finalize → deliver flow
 * - Events audit trail
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

// ─── local helpers ────────────────────────────────────────────────────────────

async function fullAcceptContract(
  app: FastifyInstance,
  requesterId: string,
  workerId: string,
  budget = 100
): Promise<{ taskId: string; contractId: string; milestones: Array<{ milestoneId: string; amountCredits: number }> }> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: authHeaders(requesterId, 'requester'),
    payload: {
      title: 'Full Lifecycle Task',
      description: 'End-to-end contract task',
      pricingMode: 'fixed',
      budget,
      deadlineAt: new Date(Date.now() + 86400000).toISOString(),
      scope: {
        allowedDataRefs: ['dataset://tenant/input.csv'],
        allowedTools: ['python'],
        egressAllowlist: ['api.tenant.local'],
        deliverableSchemaRef: 'schema://deliverable/v1',
        acceptanceTestsRef: 'tests://acceptance/v1'
      }
    }
  });
  const { taskId } = created.json<{ taskId: string }>();

  await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: authHeaders(requesterId, 'requester') });
  await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/bids`, headers: authHeaders(workerId, 'worker'), payload: { rate: budget } });

  const reserve = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reserve`, headers: authHeaders(workerId, 'worker') });
  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  const accept = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease
  });

  const contract = accept.json<{ contractId: string; milestones: Array<{ milestoneId: string; amountCredits: number }> }>();
  return { taskId, ...contract };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TASK-TEST-002: task lifecycle', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Task creation and posting
  // ─────────────────────────────────────────────────────────────────────────────

  it('requester can create and post a task (DRAFT → POSTED)', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_create', role: 'requester', capabilities: ['orchestrator'] });
    await topup(app, requester.agentId, 'requester', 100);

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Data Pipeline Task',
        description: 'Process and clean dataset',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['dataset://tenant-a/input.csv'],
          allowedTools: ['python'],
          egressAllowlist: ['api.tenant-a.local'],
          deliverableSchemaRef: 'schema://deliverable/v1',
          acceptanceTestsRef: 'tests://acceptance/v1'
        }
      }
    });

    expect(createRes.statusCode).toBe(200);
    const task = createRes.json<{ taskId: string; status: string; title: string; budget: number }>();
    expect(task.status).toBe('DRAFT');
    expect(task.title).toBe('Data Pipeline Task');
    expect(task.budget).toBe(100);

    const postRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/post`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(postRes.statusCode).toBe(200);
    expect(postRes.json<{ status: string }>().status).toBe('POSTED');
  });

  it('worker cannot create tasks (policy denied)', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_no_create', role: 'worker', capabilities: ['python'] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        title: 'Unauthorized Task',
        description: 'Should fail',
        pricingMode: 'fixed',
        budget: 50,
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

  it('task creation validates required fields', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_validate', role: 'requester', capabilities: ['orchestrator'] });
    await topup(app, requester.agentId, 'requester', 100);

    // Missing required 'scope' field
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Bad Task',
        description: 'Missing scope',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString()
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('task with custom milestone names creates milestones with those names', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_custom_ms', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_custom_ms', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Custom Milestones Task',
        description: 'Task with custom milestone names',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        milestoneNames: ['Data Ingestion', 'Transformation', 'Validation'],
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

    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: authHeaders(requester.agentId, 'requester') });
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/bids`, headers: authHeaders(worker.agentId, 'worker'), payload: { rate: 100 } });

    const reserve = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reserve`, headers: authHeaders(worker.agentId, 'worker') });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });

    expect(accept.statusCode).toBe(200);
    const contract = accept.json<{ milestones: Array<{ name: string }> }>();
    // Custom milestone names should be used (3 milestones)
    expect(contract.milestones.length).toBe(3);
    const names = contract.milestones.map((m) => m.name);
    expect(names).toContain('Data Ingestion');
    expect(names).toContain('Transformation');
    expect(names).toContain('Validation');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Task listing
  // ─────────────────────────────────────────────────────────────────────────────

  it('public task listing shows POSTED tasks without auth', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_public_list', role: 'requester', capabilities: ['orchestrator'] });
    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    // No auth header on public route
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/tasks/public'
    });

    expect(listRes.statusCode).toBe(200);
    const body = listRes.json<{ tasks: Array<{ taskId: string; status: string }> }>();
    const publicTask = body.tasks.find((t) => t.taskId === task.taskId);
    expect(publicTask).toBeDefined();
    expect(publicTask!.status).toBe('POSTED');
  });

  it('authenticated task list includes requester-owned DRAFT tasks', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_own_draft', role: 'requester', capabilities: ['orchestrator'] });
    await topup(app, requester.agentId, 'requester', 100);

    // Create a task but do NOT post it (stays DRAFT)
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Draft Task Visible',
        description: 'Should show in own list',
        pricingMode: 'fixed',
        budget: 50,
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

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(listRes.statusCode).toBe(200);
    const body = listRes.json<{ tasks: Array<{ taskId: string }> }>();
    expect(body.tasks.some((t) => t.taskId === taskId)).toBe(true);
  });

  it('worker cannot see a DRAFT task they do not own', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_draft_hidden', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_draft_hidden', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Hidden Draft',
        description: 'Should be forbidden to worker',
        pricingMode: 'fixed',
        budget: 50,
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

    // Worker tries to see a DRAFT task they don't own
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    // Should get 403 TASK_FORBIDDEN (worker cannot see DRAFT tasks)
    expect(getRes.statusCode).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Bidding mechanics
  // ─────────────────────────────────────────────────────────────────────────────

  it('multiple workers can bid on the same task', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_multi_bid', role: 'requester', capabilities: ['orchestrator'] });
    const worker1 = await onboardAgent(app, { tokenSeed: 'tl_wrk1_multi_bid', role: 'worker', capabilities: ['python'] });
    const worker2 = await onboardAgent(app, { tokenSeed: 'tl_wrk2_multi_bid', role: 'worker', capabilities: ['python'] });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    const bid1 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker1.agentId, 'worker'),
      payload: { rate: 90 }
    });

    const bid2 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker2.agentId, 'worker'),
      payload: { rate: 85 }
    });

    expect(bid1.statusCode).toBe(200);
    expect(bid2.statusCode).toBe(200);

    // Requester can see all bids
    const bidsRes = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(bidsRes.statusCode).toBe(200);
    const { bids } = bidsRes.json<{ bids: Array<{ workerAgentId: string; rate: number }> }>();
    expect(bids.length).toBe(2);

    const rates = bids.map((b) => b.rate);
    expect(rates).toContain(90);
    expect(rates).toContain(85);
  });

  it('worker cannot see bids on a task they did not create', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_bid_vis', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_bid_vis', role: 'worker', capabilities: ['python'] });

    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 80 }
    });

    const bidsRes = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(bidsRes.statusCode).toBe(403);
    expect(bidsRes.json<{ error: { code: string } }>().error.code).toBe('BIDS_FORBIDDEN');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Task cancellation
  // ─────────────────────────────────────────────────────────────────────────────

  it('requester can cancel a POSTED task (returns CLOSED status)', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_cancel_posted', role: 'requester', capabilities: ['orchestrator'] });
    await topup(app, requester.agentId, 'requester', 100);
    const task = await createPostedTask(app, requester.agentId, 'python');

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/cancel`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { reasonCode: 'NO_LONGER_NEEDED' }
    });

    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json<{ status: string }>().status).toBe('CLOSED');
  });

  it('requester can cancel a DRAFT task (DRAFT→CLOSED)', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_cancel_draft', role: 'requester', capabilities: ['orchestrator'] });
    await topup(app, requester.agentId, 'requester', 100);

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Draft to Cancel',
        description: 'Will be cancelled before posting',
        pricingMode: 'fixed',
        budget: 50,
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

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/cancel`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { reasonCode: 'CHANGED_MIND' }
    });

    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json<{ status: string }>().status).toBe('CLOSED');
  });

  it('only task owner can cancel their task', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_cancel_own', role: 'requester', capabilities: ['orchestrator'] });
    const other = await onboardAgent(app, { tokenSeed: 'tl_req_cancel_other', role: 'requester', capabilities: ['orchestrator'] });
    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/cancel`,
      headers: authHeaders(other.agentId, 'requester'),
      payload: { reasonCode: 'UNAUTHORIZED_CANCEL' }
    });

    expect(cancelRes.statusCode).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Scope manifest and vault tokens
  // ─────────────────────────────────────────────────────────────────────────────

  it('worker can access task scope with valid lease', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_scope', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_scope', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({ method: 'POST', url: `/v1/tasks/${task.taskId}/bids`, headers: authHeaders(worker.agentId, 'worker'), payload: { rate: 100 } });

    const reserve = await app.inject({ method: 'POST', url: `/v1/tasks/${task.taskId}/reserve`, headers: authHeaders(worker.agentId, 'worker') });
    const { leaseId, leaseToken } = reserve.json<{ leaseId: string; leaseToken: string }>();

    const scopeRes = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/scope?leaseId=${leaseId}&leaseToken=${leaseToken}`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(scopeRes.statusCode).toBe(200);
    const scope = scopeRes.json<{ allowedTools: string[]; allowedDataRefs: string[] }>();
    expect(scope.allowedTools).toContain('python');
    expect(scope.allowedDataRefs).toContain('dataset://tenant-a/input.csv');
  });

  it('worker cannot access scope without valid lease', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_scope_nolease', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_scope_nolease', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    // Try to access scope without lease
    const scopeRes = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}/scope?leaseId=fake_lease_id&leaseToken=fake_token`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(scopeRes.statusCode).toBe(404);
  });

  it('vault token issued for valid data ref within task scope', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_vault', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_vault', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 120);

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Vault Token Task',
        description: 'Task with vault data ref',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['vault://tenant/secret.json'],
          allowedTools: ['python'],
          egressAllowlist: ['api.tenant.local'],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1'
        }
      }
    });
    const { taskId } = createRes.json<{ taskId: string }>();
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: authHeaders(requester.agentId, 'requester') });

    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/bids`, headers: authHeaders(worker.agentId, 'worker'), payload: { rate: 100 } });

    const reserve = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reserve`, headers: authHeaders(worker.agentId, 'worker') });
    const { leaseId, leaseToken } = reserve.json<{ leaseId: string; leaseToken: string }>();

    const vaultRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/vault-token`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        leaseId,
        leaseToken,
        dataRef: 'vault://tenant/secret.json'
      }
    });

    expect(vaultRes.statusCode).toBe(200);
    const body = vaultRes.json<{ vaultToken: string }>();
    expect(body.vaultToken).toBeTruthy();
    expect(body.vaultToken.length).toBeGreaterThan(8);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Milestone execution flow
  // ─────────────────────────────────────────────────────────────────────────────

  it('milestone start → artifact upload → finalize → deliver → accept full flow', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_artifact_flow', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_artifact_flow', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const { contractId, milestones } = await fullAcceptContract(app, requester.agentId, worker.agentId, 100);
    const ms = milestones[0];

    // Start milestone
    const startRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${ms.milestoneId}/start`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(startRes.statusCode).toBe(200);
    const { executionId } = startRes.json<{ executionId: string }>();
    expect(executionId).toBeTruthy();

    // Upload URL for artifact
    const uploadRes = await app.inject({
      method: 'POST',
      url: '/v1/artifacts/upload-url',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { contractId, milestoneId: ms.milestoneId, fileName: 'output.json' }
    });
    expect(uploadRes.statusCode).toBe(200);
    const { artifactId, uploadUrl, finalizeToken } = uploadRes.json<{ artifactId: string; uploadUrl: string; finalizeToken: string }>();
    expect(artifactId).toBeTruthy();
    expect(uploadUrl).toContain('uploads.clawbot.local');
    expect(finalizeToken).toBeTruthy();

    // Finalize artifact with valid 64-char hex sha256 + signature
    const finalizeRes = await app.inject({
      method: 'POST',
      url: `/v1/artifacts/${artifactId}/finalize`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        sha256: 'a'.repeat(64),
        signature: 'b'.repeat(64),
        finalizeToken
      }
    });
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.json<{ validationStatus: string }>().validationStatus).toBe('VALID');

    // Get signature preview for delivery
    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'deliverable-content-1' }
    });
    const { signature } = sigRes.json<{ signature: string }>();

    // Deliver milestone with artifact reference
    const deliverRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${ms.milestoneId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { content: 'deliverable-content-1', signature, artifactId }
    });
    expect(deliverRes.statusCode).toBe(200);

    // Accept milestone
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${ms.milestoneId}/accept`,
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(acceptRes.statusCode).toBe(200);
    // ContractTerms is returned — check the specific milestone's status is ACCEPTED
    const acceptBody = acceptRes.json<{ milestones: Array<{ milestoneId: string; status: string }> }>();
    const acceptedMs = acceptBody.milestones.find((m) => m.milestoneId === ms.milestoneId);
    expect(acceptedMs?.status).toBe('ACCEPTED');
  });

  it('artifact with invalid sha256 format (not 64 hex chars) is marked INVALID', async () => {
    // Note: token seeds must not contain 'invalid' as FakeMoltbookVerifier uses that to mark valid=false
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_bad_sha_check', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_bad_sha_check', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const { contractId, milestones } = await fullAcceptContract(app, requester.agentId, worker.agentId, 100);
    const ms = milestones[0];

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${ms.milestoneId}/start`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/v1/artifacts/upload-url',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { contractId, milestoneId: ms.milestoneId, fileName: 'bad.json' }
    });
    const { artifactId, finalizeToken } = uploadRes.json<{ artifactId: string; finalizeToken: string }>();

    // Invalid sha256 (too short, non-hex chars)
    const finalizeRes = await app.inject({
      method: 'POST',
      url: `/v1/artifacts/${artifactId}/finalize`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        sha256: 'not-a-valid-sha256-hash-at-all',
        signature: 'also-not-valid-signature-abcdef',
        finalizeToken
      }
    });

    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.json<{ validationStatus: string }>().validationStatus).toBe('INVALID');
  });

  it('delivery with invalid artifact (not finalized) is rejected', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_unfinalized_art', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_unfinalized_art', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const { contractId, milestones } = await fullAcceptContract(app, requester.agentId, worker.agentId, 100);
    const ms = milestones[0];

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${ms.milestoneId}/start`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    // Create an upload URL but do NOT finalize it (artifact stays INVALID)
    const uploadRes = await app.inject({
      method: 'POST',
      url: '/v1/artifacts/upload-url',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { contractId, milestoneId: ms.milestoneId, fileName: 'unfinalized.json' }
    });
    const { artifactId } = uploadRes.json<{ artifactId: string }>();

    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'content' }
    });
    const { signature } = sigRes.json<{ signature: string }>();

    // Deliver with unfinalized artifact (validationStatus=INVALID) → should fail
    const deliverRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${ms.milestoneId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { content: 'content', signature, artifactId }
    });

    expect(deliverRes.statusCode).toBe(409);
    expect(deliverRes.json<{ error: { code: string } }>().error.code).toBe('ARTIFACT_NOT_VALID');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Reputation tracking
  // ─────────────────────────────────────────────────────────────────────────────

  it('worker reputation increases after successful milestone acceptance', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_reputation', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_reputation', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    // Check initial reputation (should be low/zero)
    const initReputation = await app.inject({
      method: 'GET',
      url: `/v1/reputation/${worker.agentId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(initReputation.statusCode).toBe(200);
    const initScore = initReputation.json<{ score: number }>().score;

    const { contractId, milestones } = await fullAcceptContract(app, requester.agentId, worker.agentId, 100);
    const ms = milestones[0];

    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'reputation-content' }
    });
    const { signature } = sigRes.json<{ signature: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'reputation-content', signature }
    });

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: ms.milestoneId }
    });

    // Check reputation after successful delivery
    const afterReputation = await app.inject({
      method: 'GET',
      url: `/v1/reputation/${worker.agentId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(afterReputation.statusCode).toBe(200);
    const afterScore = afterReputation.json<{ score: number }>().score;
    expect(afterScore).toBeGreaterThan(initScore);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Contract access control
  // ─────────────────────────────────────────────────────────────────────────────

  it('contract read returns full details to requester and worker', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_contract_read', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_contract_read', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const { contractId } = await fullAcceptContract(app, requester.agentId, worker.agentId);

    const reqContract = await app.inject({
      method: 'GET',
      url: `/v1/contracts/${contractId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(reqContract.statusCode).toBe(200);
    expect(reqContract.json<{ contractId: string }>().contractId).toBe(contractId);

    const wrkContract = await app.inject({
      method: 'GET',
      url: `/v1/contracts/${contractId}`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(wrkContract.statusCode).toBe(200);
  });

  it('outsider cannot read a contract they are not party to', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_contract_outsider', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_contract_outsider', role: 'worker', capabilities: ['python'] });
    const outsider = await onboardAgent(app, { tokenSeed: 'tl_outsider_contract', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const { contractId } = await fullAcceptContract(app, requester.agentId, worker.agentId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/contracts/${contractId}`,
      headers: authHeaders(outsider.agentId, 'worker')
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CONTRACT_FORBIDDEN');
  });

  it('non-existent contract returns 404', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_404_contract', role: 'worker', capabilities: ['python'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/contracts/contract_does_not_exist_xyz',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(404);
  });

  it('non-existent task returns 404', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_404_task', role: 'worker', capabilities: ['python'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/tasks/task_does_not_exist_xyz',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(404);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Audit events trail
  // ─────────────────────────────────────────────────────────────────────────────

  it('events are recorded for task and contract operations', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_events', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_events', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    // Check events for the task
    const eventsRes = await app.inject({
      method: 'GET',
      url: `/v1/events/${task.taskId}`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(eventsRes.statusCode).toBe(200);
    const { events } = eventsRes.json<{ events: Array<{ eventType: string }> }>();
    expect(events.length).toBeGreaterThan(0);
    // Should have task.created and task.posted events
    expect(events.some((e) => e.eventType === 'task.created')).toBe(true);
    expect(events.some((e) => e.eventType === 'task.posted')).toBe(true);
  });

  it('moderator can view all audit events without entity filter', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_all_events', role: 'requester', capabilities: ['orchestrator'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'tl_mod_all_events', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 100);

    await createPostedTask(app, requester.agentId, 'python');

    const eventsRes = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: authHeaders(moderator.agentId, 'moderator')
    });

    expect(eventsRes.statusCode).toBe(200);
    const { events } = eventsRes.json<{ events: unknown[] }>();
    expect(events.length).toBeGreaterThan(0);
  });

  it('worker cannot view all events (moderator-only without entityId)', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_events_forbidden', role: 'worker', capabilities: ['python'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Signature preview security
  // ─────────────────────────────────────────────────────────────────────────────

  it('signature preview is only accessible to worker or admin', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_sig_forbidden', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_sig_forbidden', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const { contractId, milestones } = await fullAcceptContract(app, requester.agentId, worker.agentId);
    const ms = milestones[0];

    // Requester tries to get signature preview (role check fails)
    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: ms.milestoneId, content: 'attempt-to-forge-sig' }
    });

    expect(sigRes.statusCode).toBe(403);
  });

  it('different content produces different signatures (sig is content-specific)', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'tl_req_unique_sig', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'tl_wrk_unique_sig', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 100);

    const { contractId, milestones } = await fullAcceptContract(app, requester.agentId, worker.agentId);
    const ms = milestones[0];

    const sig1Res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'content-alpha' }
    });

    const sig2Res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'content-beta' }
    });

    expect(sig1Res.statusCode).toBe(200);
    expect(sig2Res.statusCode).toBe(200);
    expect(sig1Res.json<{ signature: string }>().signature).not.toBe(sig2Res.json<{ signature: string }>().signature);
  });
});
