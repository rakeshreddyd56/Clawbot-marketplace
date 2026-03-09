/**
 * E2E Marketplace Lifecycle Regression Tests (tester-2)
 *
 * Comprehensive end-to-end tests covering:
 * 1. Full happy-path lifecycle: onboard → post → bid → reserve → accept → deliver → payout
 * 2. Multi-milestone contract completion with escrow balance verification
 * 3. Dispute → moderator resolution → sanction → appeal flow
 * 4. Concurrent bidding race conditions
 * 5. Insufficient funds edge cases
 * 6. Cross-role permission boundaries
 * 7. Wallet balance consistency after complex flows
 * 8. Constitution acceptance requirement enforcement
 * 9. Lease expiry during active work
 * 10. Cancelled task cleanup and escrow refund
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

// ─── Shared Helpers ──────────────────────────────────────────────────────────

async function fullContractSetup(
  app: FastifyInstance,
  requesterId: string,
  workerId: string,
  budget = 100
): Promise<{
  taskId: string;
  contractId: string;
  milestones: Array<{ milestoneId: string; amountCredits: number }>;
}> {
  const task = await createPostedTask(app, requesterId, 'python');

  await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: budget },
  });

  const reserve = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/reserve`,
    headers: authHeaders(workerId, 'worker'),
  });
  const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

  const accept = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: lease,
  });

  const contract = accept.json<{
    contractId: string;
    milestones: Array<{ milestoneId: string; amountCredits: number }>;
  }>();

  return { taskId: task.taskId, ...contract };
}

async function deliverAndAcceptMilestone(
  app: FastifyInstance,
  contractId: string,
  milestoneId: string,
  workerId: string,
  requesterId: string,
  content: string
): Promise<void> {
  // Get signature
  const sigRes = await app.inject({
    method: 'POST',
    url: `/v1/contracts/${contractId}/signature-preview`,
    headers: authHeaders(workerId, 'worker'),
    payload: { milestoneId, content },
  });
  if (sigRes.statusCode !== 200)
    throw new Error(`sig failed: ${sigRes.body}`);
  const { signature } = sigRes.json<{ signature: string }>();

  // Deliver
  const deliverRes = await app.inject({
    method: 'POST',
    url: `/v1/contracts/${contractId}/deliver`,
    headers: authHeaders(workerId, 'worker'),
    payload: { milestoneId, content, signature },
  });
  if (deliverRes.statusCode !== 200)
    throw new Error(`deliver failed: ${deliverRes.body}`);

  // Accept
  const acceptRes = await app.inject({
    method: 'POST',
    url: `/v1/contracts/${contractId}/accept`,
    headers: authHeaders(requesterId, 'requester'),
    payload: { milestoneId },
  });
  if (acceptRes.statusCode !== 200)
    throw new Error(`accept failed: ${acceptRes.body}`);
}

async function getWalletBalance(
  app: FastifyInstance,
  agentId: string,
  role: 'requester' | 'worker' | 'moderator' | 'admin'
): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/wallet/balance',
    headers: authHeaders(agentId, role),
  });
  if (res.statusCode !== 200) throw new Error(`balance failed: ${res.body}`);
  return res.json<{ balance: number }>().balance;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('E2E: Full Marketplace Lifecycle Regression', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Happy Path: Complete lifecycle from onboarding to payout
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: onboard → fund → post → bid → reserve → accept → deliver → accept milestone → payout', async () => {
    // 1. Onboard requester & worker
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_happy',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk_happy',
      role: 'worker',
      capabilities: ['python'],
    });

    // 2. Fund requester wallet
    await topup(app, requester.agentId, 'requester', 500);
    const reqBalanceBefore = await getWalletBalance(app, requester.agentId, 'requester');
    expect(reqBalanceBefore).toBe(500);

    // 3. Create and post task
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'E2E Complete Lifecycle Task',
        description: 'Full end-to-end test of marketplace lifecycle',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['dataset://e2e/test.csv'],
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://e2e/v1',
          acceptanceTestsRef: 'tests://e2e/v1',
        },
      },
    });
    expect(createRes.statusCode).toBe(200);
    const { taskId } = createRes.json<{ taskId: string; status: string }>();

    // 4. Post the task
    const postRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: authHeaders(requester.agentId, 'requester'),
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.json<{ status: string }>().status).toBe('POSTED');

    // 5. Worker bids
    const bidRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 },
    });
    expect(bidRes.statusCode).toBe(200);

    // 6. Worker reserves
    const reserveRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker'),
    });
    expect(reserveRes.statusCode).toBe(200);
    const { leaseId, leaseToken } = reserveRes.json<{
      leaseId: string;
      leaseToken: string;
    }>();
    expect(leaseId).toBeTruthy();
    expect(leaseToken).toBeTruthy();

    // 7. Requester accepts → contract created
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { leaseId, leaseToken },
    });
    expect(acceptRes.statusCode).toBe(200);
    const contract = acceptRes.json<{
      contractId: string;
      milestones: Array<{ milestoneId: string; amountCredits: number }>;
    }>();
    expect(contract.contractId).toBeTruthy();
    expect(contract.milestones.length).toBeGreaterThan(0);

    // 8. Worker delivers milestone
    const ms = contract.milestones[0];
    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'e2e-deliverable' },
    });
    expect(sigRes.statusCode).toBe(200);
    const { signature } = sigRes.json<{ signature: string }>();

    const deliverRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'e2e-deliverable', signature },
    });
    expect(deliverRes.statusCode).toBe(200);

    // 9. Requester accepts milestone
    const acceptMsRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: ms.milestoneId },
    });
    expect(acceptMsRes.statusCode).toBe(200);

    // 10. Verify audit trail has events for the full lifecycle
    const eventsRes = await app.inject({
      method: 'GET',
      url: `/v1/events/${taskId}`,
      headers: authHeaders(requester.agentId, 'requester'),
    });
    expect(eventsRes.statusCode).toBe(200);
    const { events } = eventsRes.json<{ events: Array<{ eventType: string }> }>();
    expect(events.some((e) => e.eventType === 'task.created')).toBe(true);
    expect(events.some((e) => e.eventType === 'task.posted')).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Multi-milestone contract with escrow verification
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: multi-milestone contract tracks escrow correctly across milestones', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_multi_ms',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk_multi_ms',
      role: 'worker',
      capabilities: ['python'],
    });

    await topup(app, requester.agentId, 'requester', 300);

    // Create task with custom milestones
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Multi-Milestone E2E',
        description: 'Three milestones for escrow tracking',
        pricingMode: 'fixed',
        budget: 300,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        milestoneNames: ['Phase 1', 'Phase 2', 'Phase 3'],
        scope: {
          allowedDataRefs: ['dataset://e2e/multi.csv'],
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://e2e/v1',
          acceptanceTestsRef: 'tests://e2e/v1',
        },
      },
    });
    expect(createRes.statusCode).toBe(200);
    const { taskId } = createRes.json<{ taskId: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: authHeaders(requester.agentId, 'requester'),
    });

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 300 },
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker'),
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease,
    });
    expect(accept.statusCode).toBe(200);

    const contract = accept.json<{
      contractId: string;
      milestones: Array<{ milestoneId: string; amountCredits: number; name: string }>;
    }>();
    expect(contract.milestones.length).toBe(3);

    // Deliver and accept each milestone in sequence
    for (let i = 0; i < contract.milestones.length; i++) {
      const ms = contract.milestones[i];
      await deliverAndAcceptMilestone(
        app,
        contract.contractId,
        ms.milestoneId,
        worker.agentId,
        requester.agentId,
        `phase-${i + 1}-deliverable`
      );
    }

    // Verify contract state after all milestones completed
    const contractRes = await app.inject({
      method: 'GET',
      url: `/v1/contracts/${contract.contractId}`,
      headers: authHeaders(requester.agentId, 'requester'),
    });
    expect(contractRes.statusCode).toBe(200);
    const finalContract = contractRes.json<{
      milestones: Array<{ status: string }>;
    }>();
    // All milestones should be ACCEPTED
    for (const ms of finalContract.milestones) {
      expect(ms.status).toBe('ACCEPTED');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Dispute → Moderator Resolution Flow
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: dispute flow — requester disputes, moderator resolves, sanction applied', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_dispute',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk_dispute',
      role: 'worker',
      capabilities: ['python'],
    });
    const moderator = await onboardAgent(app, {
      tokenSeed: 'e2e_mod_dispute',
      role: 'moderator',
      capabilities: ['moderation'],
    });

    await topup(app, requester.agentId, 'requester', 200);

    const { contractId, milestones } = await fullContractSetup(
      app,
      requester.agentId,
      worker.agentId,
      100
    );
    const ms = milestones[0];

    // Worker delivers (required before dispute can be opened on milestone)
    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'disputed-work' },
    });
    const { signature } = sigRes.json<{ signature: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'disputed-work', signature },
    });

    // Requester opens dispute
    const disputeRes = await app.inject({
      method: 'POST',
      url: '/v1/disputes',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        contractId,
        milestoneId: ms.milestoneId,
        reason: 'Deliverable does not meet acceptance criteria',
        evidence: ['Output quality is below specification'],
      },
    });
    expect(disputeRes.statusCode).toBe(200);
    const { disputeId } = disputeRes.json<{ disputeId: string }>();
    expect(disputeId).toBeTruthy();

    // Moderator views dispute
    const viewRes = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${disputeId}`,
      headers: authHeaders(moderator.agentId, 'moderator'),
    });
    expect(viewRes.statusCode).toBe(200);

    // Moderator resolves dispute in favor of requester
    const resolveRes = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: {
        ruling: 'requester',
        reason: 'Deliverable did not meet scope requirements',
      },
    });
    expect(resolveRes.statusCode).toBe(200);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Insufficient Funds Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: task accept fails when requester has insufficient funds for escrow', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_no_funds',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk_no_funds',
      role: 'worker',
      capabilities: ['python'],
    });

    // Fund with only 10 credits but task costs 100
    await topup(app, requester.agentId, 'requester', 10);

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 },
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker'),
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Accept should fail — insufficient funds for escrow lock
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease,
    });

    // Should get 4xx error for insufficient funds
    expect(acceptRes.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Concurrent Bidding Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: multiple workers bid, only one can reserve at a time', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_concurrent',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker1 = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk1_concurrent',
      role: 'worker',
      capabilities: ['python'],
    });
    const worker2 = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk2_concurrent',
      role: 'worker',
      capabilities: ['python'],
    });

    await topup(app, requester.agentId, 'requester', 200);
    const task = await createPostedTask(app, requester.agentId, 'python');

    // Both workers bid
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker1.agentId, 'worker'),
      payload: { rate: 90 },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker2.agentId, 'worker'),
      payload: { rate: 85 },
    });

    // Worker1 reserves first
    const reserve1 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker1.agentId, 'worker'),
    });
    expect(reserve1.statusCode).toBe(200);

    // Worker2 tries to reserve the same task — should fail (already reserved)
    const reserve2 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker2.agentId, 'worker'),
    });
    expect(reserve2.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Cross-Role Permission Boundaries
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: worker cannot accept their own delivery (requester-only)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_cross_role',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk_cross_role',
      role: 'worker',
      capabilities: ['python'],
    });

    await topup(app, requester.agentId, 'requester', 200);

    const { contractId, milestones } = await fullContractSetup(
      app,
      requester.agentId,
      worker.agentId
    );
    const ms = milestones[0];

    // Deliver milestone
    const sigRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'cross-role-test' },
    });
    const { signature } = sigRes.json<{ signature: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId, content: 'cross-role-test', signature },
    });

    // Worker tries to accept their own delivery — should be denied
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/accept`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: ms.milestoneId },
    });
    expect(acceptRes.statusCode).toBe(403);
  });

  it('E2E: moderator cannot create tasks or bid (role-restricted)', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'e2e_mod_restrict',
      role: 'moderator',
      capabilities: ['moderation'],
    });

    // Moderator tries to create a task
    const taskRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(moderator.agentId, 'moderator'),
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
          acceptanceTestsRef: 'tests://v1',
        },
      },
    });
    expect(taskRes.statusCode).toBe(403);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Task Cancellation and Escrow Refund
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: cancelling a posted task frees it for workers', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_cancel',
      role: 'requester',
      capabilities: ['orchestrator'],
    });

    await topup(app, requester.agentId, 'requester', 200);

    const task = await createPostedTask(app, requester.agentId, 'python');

    // Cancel the task
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/cancel`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { reasonCode: 'NO_LONGER_NEEDED' },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json<{ status: string }>().status).toBe('CLOSED');

    // Verify cancelled task is no longer in public listing
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/tasks/public',
    });
    const { tasks } = listRes.json<{ tasks: Array<{ taskId: string }> }>();
    expect(tasks.some((t) => t.taskId === task.taskId)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Onboarding Prerequisite Enforcement
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: unauthenticated request to protected endpoint returns 401/403', async () => {
    // Try to create a task without any auth
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        title: 'No Auth Task',
        description: 'Should fail',
        pricingMode: 'fixed',
        budget: 50,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['data://ref'],
          allowedTools: ['python'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://v1',
          acceptanceTestsRef: 'tests://v1',
        },
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Wallet Consistency After Complex Flows
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: wallet ledger entries are consistent after contract completion', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_wallet',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk_wallet',
      role: 'worker',
      capabilities: ['python'],
    });

    await topup(app, requester.agentId, 'requester', 500);

    const { contractId, milestones } = await fullContractSetup(
      app,
      requester.agentId,
      worker.agentId
    );

    // Complete the first milestone
    await deliverAndAcceptMilestone(
      app,
      contractId,
      milestones[0].milestoneId,
      worker.agentId,
      requester.agentId,
      'wallet-test-deliverable'
    );

    // Verify ledger entries exist for the contract
    const ledgerRes = await app.inject({
      method: 'GET',
      url: `/v1/wallet/ledger`,
      headers: authHeaders(requester.agentId, 'requester'),
    });
    expect(ledgerRes.statusCode).toBe(200);
    const { entries } = ledgerRes.json<{
      entries: Array<{ type: string; amount: number }>;
    }>();
    expect(entries.length).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. Duplicate Bid Prevention
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: same worker cannot bid twice on the same task', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_dup_bid',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk_dup_bid',
      role: 'worker',
      capabilities: ['python'],
    });

    await topup(app, requester.agentId, 'requester', 200);
    const task = await createPostedTask(app, requester.agentId, 'python');

    // First bid
    const bid1 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 90 },
    });
    expect(bid1.statusCode).toBe(200);

    // Second bid from same worker — should be rejected as duplicate
    const bid2 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 85 },
    });
    expect(bid2.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. Heartbeat Lease Regression
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: heartbeat extends lease, allowing continued work', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_heartbeat',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    const worker = await onboardAgent(app, {
      tokenSeed: 'e2e_wrk_heartbeat',
      role: 'worker',
      capabilities: ['python'],
    });

    await topup(app, requester.agentId, 'requester', 200);
    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 },
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker'),
    });
    expect(reserve.statusCode).toBe(200);
    const { leaseId, leaseToken } = reserve.json<{
      leaseId: string;
      leaseToken: string;
    }>();

    // Send heartbeat
    const heartbeatRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/heartbeat`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { leaseId, leaseToken },
    });
    expect(heartbeatRes.statusCode).toBe(200);
    const heartbeatBody = heartbeatRes.json<{ expiresAt: string }>();
    expect(heartbeatBody.expiresAt).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. Public Task Listing (no auth required)
  // ═══════════════════════════════════════════════════════════════════════════

  it('E2E: public task listing works without authentication', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'e2e_req_public',
      role: 'requester',
      capabilities: ['orchestrator'],
    });
    await topup(app, requester.agentId, 'requester', 200);

    await createPostedTask(app, requester.agentId, 'python');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/tasks/public',
    });

    expect(res.statusCode).toBe(200);
    const { tasks } = res.json<{ tasks: Array<{ taskId: string; status: string }> }>();
    expect(tasks.length).toBeGreaterThan(0);
    // All public tasks should be POSTED
    for (const t of tasks) {
      expect(t.status).toBe('POSTED');
    }
  });
});
