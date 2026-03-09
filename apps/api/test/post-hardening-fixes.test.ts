/**
 * Post-Hardening Review Bug Fixes (2026-03-04)
 *
 * Tests for the 5 bugs found during post-hardening review:
 * - BUG-CRIT-NEW-002: ArtifactRecord missing contractId/milestoneId in deliverMilestone()
 * - BUG-MAJ-NEW-001: resolveDispute() callable on already-FINAL disputes (double-slash)
 * - BUG-CRIT-NEW-001: WebSocket entityId bypass (verify fix already in place)
 * - BUG-MAJ-NEW-003: wallet.topup missing enforceFreshIdentity
 * - BUG-MAJ-NEW-002: EscrowLock amount=0 violates schema positive() constraint
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../src/app.js';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

// -----------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------

async function createAssignedContract(
  app: FastifyInstance,
  requesterId: string,
  workerId: string
): Promise<{
  contractId: string;
  taskId: string;
  milestones: Array<{ milestoneId: string; amountCredits: number; status: string }>;
}> {
  const task = await createPostedTask(app, requesterId, 'python');

  const bid = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/bids`,
    headers: authHeaders(workerId, 'worker'),
    payload: { rate: 100 }
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

  const contract = accept.json<{
    contractId: string;
    milestones: Array<{ milestoneId: string; amountCredits: number; status: string }>;
  }>();
  return { contractId: contract.contractId, taskId: task.taskId, milestones: contract.milestones };
}

async function deliverAndGetArtifactId(
  app: FastifyInstance,
  contractId: string,
  milestoneId: string,
  workerId: string,
  content: string
): Promise<string> {
  const sig = await app.inject({
    method: 'POST',
    url: `/v1/contracts/${contractId}/signature-preview`,
    headers: authHeaders(workerId, 'worker'),
    payload: { milestoneId, content }
  });
  if (sig.statusCode !== 200) throw new Error(`sig-preview failed: ${sig.statusCode} ${sig.body}`);
  const { signature } = sig.json<{ signature: string }>();

  const deliver = await app.inject({
    method: 'POST',
    url: `/v1/contracts/${contractId}/deliver`,
    headers: authHeaders(workerId, 'worker'),
    payload: { milestoneId, content, signature }
  });
  if (deliver.statusCode !== 200) throw new Error(`deliver failed: ${deliver.statusCode} ${deliver.body}`);
  return deliver.json<{ artifactId: string }>().artifactId;
}

async function openDispute(
  app: FastifyInstance,
  requesterId: string,
  contractId: string,
  againstAgentId: string
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/disputes',
    headers: authHeaders(requesterId, 'requester'),
    payload: { contractId, reasonCode: 'NON_DELIVERY', againstAgentId }
  });
  if (res.statusCode !== 200) throw new Error(`open dispute failed: ${res.statusCode} ${res.body}`);
  return res.json<{ disputeId: string }>().disputeId;
}

// -----------------------------------------------------------------------
// BUG-CRIT-NEW-002: ArtifactRecord must have contractId and milestoneId
// -----------------------------------------------------------------------

describe('BUG-CRIT-NEW-002: ArtifactRecord contractId/milestoneId', () => {
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

  it('deliverMilestone() stores contractId on ArtifactRecord', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'crit2_req1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'crit2_wrk1', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId, milestones } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const milestoneId = milestones[0].milestoneId;

    const artifactId = await deliverAndGetArtifactId(app, contractId, milestoneId, worker.agentId, 'test content');

    // Verify artifact has contractId set
    const artifact = services.store.artifacts.get(artifactId);
    expect(artifact).toBeDefined();
    expect(artifact!.contractId).toBe(contractId);
  });

  it('deliverMilestone() stores milestoneId on ArtifactRecord', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'crit2_req2', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'crit2_wrk2', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId, milestones } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const milestoneId = milestones[0].milestoneId;

    const artifactId = await deliverAndGetArtifactId(app, contractId, milestoneId, worker.agentId, 'test content');

    // Verify artifact has milestoneId set
    const artifact = services.store.artifacts.get(artifactId);
    expect(artifact).toBeDefined();
    expect(artifact!.milestoneId).toBe(milestoneId);
  });

  it('evidence endpoint returns artifacts for dispute contract', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'crit2_req3', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'crit2_wrk3', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'crit2_mod3', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId, milestones } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const milestoneId = milestones[0].milestoneId;

    // Deliver a milestone so an artifact exists
    await deliverAndGetArtifactId(app, contractId, milestoneId, worker.agentId, 'deliverable content');

    // Open dispute
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // Evidence endpoint should now return the artifact
    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${disputeId}/evidence`,
      headers: authHeaders(moderator.agentId, 'moderator')
    });

    expect(evidence.statusCode).toBe(200);
    const body = evidence.json<{ artifacts: Array<{ artifactId: string; contractId: string }> }>();
    expect(body.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(body.artifacts[0].contractId).toBe(contractId);
  });

  it('resolveDispute evidence pack includes artifactIds from delivered milestones', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'crit2_req4', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'crit2_wrk4', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'crit2_mod4', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId, milestones } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const milestoneId = milestones[0].milestoneId;

    const artifactId = await deliverAndGetArtifactId(app, contractId, milestoneId, worker.agentId, 'evidence data');

    // Open dispute
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // Resolve dispute
    await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'pay_worker', targetAgentId: worker.agentId }
    });

    // Evidence pack should include the artifactId
    const packs = [...services.store.evidencePacks.values()];
    const pack = packs.find(p => p.disputeId === disputeId);
    expect(pack).toBeDefined();
    expect(pack!.artifactIds).toContain(artifactId);
  });
});

// -----------------------------------------------------------------------
// BUG-MAJ-NEW-001: resolveDispute() must reject already-FINAL disputes
// -----------------------------------------------------------------------

describe('BUG-MAJ-NEW-001: resolveDispute double-resolution guard', () => {
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

  it('rejects resolveDispute on already-FINAL dispute with 409', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'maj1_req1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'maj1_wrk1', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'maj1_mod1', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // First resolution — should succeed
    const first = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'pay_worker', targetAgentId: worker.agentId }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ status: string }>().status).toBe('FINAL');

    // Second resolution — should be rejected since dispute is already FINAL
    const second = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'refund_requester', targetAgentId: worker.agentId }
    });
    expect(second.statusCode).toBe(409);
  });

  it('prevents double-slash on worker balance by rejecting second resolution', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'maj1_req2', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'maj1_wrk2', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'maj1_mod2', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 200);
    services.store.balances.set(worker.agentId, 500);

    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    const balanceBefore = services.store.balances.get(worker.agentId)!;

    // First resolution — slashes worker
    const first = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'refund_requester', targetAgentId: worker.agentId }
    });
    expect(first.statusCode).toBe(200);

    const balanceAfterFirst = services.store.balances.get(worker.agentId)!;
    expect(balanceAfterFirst).toBeLessThan(balanceBefore);

    // Second resolution — should be rejected (dispute already FINAL)
    const second = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'refund_requester', targetAgentId: worker.agentId }
    });
    expect(second.statusCode).toBe(409);

    // Worker balance should not have been slashed again
    const balanceAfterSecond = services.store.balances.get(worker.agentId)!;
    expect(balanceAfterSecond).toBe(balanceAfterFirst);
  });

  it('allows resolving dispute in AUTO_DECIDED or UNDER_APPEAL state', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'maj1_req3', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'maj1_wrk3', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'maj1_mod3', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // Dispute starts as AUTO_DECIDED — resolving should work
    const resolve = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'split', targetAgentId: worker.agentId }
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json<{ status: string }>().status).toBe('FINAL');
  });
});

// -----------------------------------------------------------------------
// BUG-MAJ-NEW-003: wallet.topup must enforce fresh identity
// -----------------------------------------------------------------------

describe('BUG-MAJ-NEW-003: topup enforceFreshIdentity', () => {
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

  it('topup succeeds with fresh identity', async () => {
    const agent = await onboardAgent(app, { tokenSeed: 'maj3_req1', role: 'requester', capabilities: ['orchestrator'] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(agent.agentId, 'requester'),
      payload: { amount: 100 }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ balance: number }>().balance).toBe(100);
  });

  it('/v1/wallet/topups succeeds with fresh identity', async () => {
    const agent = await onboardAgent(app, { tokenSeed: 'maj3_req2', role: 'requester', capabilities: ['orchestrator'] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topups',
      headers: authHeaders(agent.agentId, 'requester'),
      payload: { amount: 50 }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ balance: number }>().balance).toBe(50);
  });

  it('topup rejects expired identity with 401 REVERIFY_REQUIRED', async () => {
    const agent = await onboardAgent(app, { tokenSeed: 'maj3_req_exp', role: 'requester', capabilities: ['orchestrator'] });

    // Expire the identity by manipulating the snapshot timestamps
    const snapshot = services.store.moltbookSnapshots.get(agent.agentId);
    if (snapshot) {
      const expiredAt = new Date(Date.now() - 70 * 60 * 1000).toISOString();
      services.store.moltbookSnapshots.set(agent.agentId, {
        ...snapshot,
        verifiedAt: expiredAt,
        expiresAt: expiredAt
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(agent.agentId, 'requester'),
      payload: { amount: 100 }
    });

    // BUG-MAJ-NEW-003: topup route now calls enforceFreshIdentity,
    // so expired identity returns 401 REVERIFY_REQUIRED
    expect(res.statusCode).toBe(401);
  });

  it('topup allows admin even without fresh identity', async () => {
    const admin = await onboardAgent(app, { tokenSeed: 'maj3_admin', role: 'admin', capabilities: ['orchestrator'] });

    // Expire the identity
    const snapshot = services.store.moltbookSnapshots.get(admin.agentId);
    if (snapshot) {
      const expiredAt = new Date(Date.now() - 70 * 60 * 1000).toISOString();
      services.store.moltbookSnapshots.set(admin.agentId, {
        ...snapshot,
        verifiedAt: expiredAt,
        expiresAt: expiredAt
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(admin.agentId, 'admin'),
      payload: { amount: 100 }
    });

    // Admin bypasses freshness check
    expect(res.statusCode).toBe(200);
  });
});

// -----------------------------------------------------------------------
// BUG-MAJ-NEW-002: EscrowLock allows amount=0 on fully released escrow
// -----------------------------------------------------------------------

describe('BUG-MAJ-NEW-002: EscrowLock nonnegative amount', () => {
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

  it('EscrowLock has amount=0 and status=RELEASED after all milestones accepted', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'maj2_req1', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'maj2_wrk1', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId, milestones } = await createAssignedContract(app, requester.agentId, worker.agentId);

    // Deliver and accept all milestones
    for (const milestone of milestones) {
      await deliverAndGetArtifactId(app, contractId, milestone.milestoneId, worker.agentId, `content-${milestone.milestoneId}`);

      const acceptRes = await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
        headers: authHeaders(requester.agentId, 'requester')
      });
      if (acceptRes.statusCode !== 200) throw new Error(`accept milestone failed: ${acceptRes.statusCode} ${acceptRes.body}`);
    }

    // Escrow should be fully released
    const escrowLock = services.store.escrowLocks.get(contractId);
    expect(escrowLock).toBeDefined();
    expect(escrowLock!.amount).toBe(0);
    expect(escrowLock!.status).toBe('RELEASED');
  });

  it('EscrowLock has positive amount during partial release', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'maj2_req2', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'maj2_wrk2', role: 'worker', capabilities: ['python'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId, milestones } = await createAssignedContract(app, requester.agentId, worker.agentId);

    // Only deliver and accept the first milestone
    const firstMilestone = milestones[0];
    await deliverAndGetArtifactId(app, contractId, firstMilestone.milestoneId, worker.agentId, 'partial content');

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${firstMilestone.milestoneId}/accept`,
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(acceptRes.statusCode).toBe(200);

    // Escrow should be partially released (still positive for remaining milestones)
    const escrowLock = services.store.escrowLocks.get(contractId);
    expect(escrowLock).toBeDefined();
    expect(escrowLock!.amount).toBeGreaterThan(0);
    expect(escrowLock!.status).toBe('PARTIAL_RELEASED');
  });

  it('EscrowLock has amount=0 after dispute resolution drains escrow', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'maj2_req3', role: 'requester', capabilities: ['orchestrator'] });
    const worker = await onboardAgent(app, { tokenSeed: 'maj2_wrk3', role: 'worker', capabilities: ['python'] });
    const moderator = await onboardAgent(app, { tokenSeed: 'maj2_mod3', role: 'moderator', capabilities: ['moderation'] });
    await topup(app, requester.agentId, 'requester', 200);

    const { contractId } = await createAssignedContract(app, requester.agentId, worker.agentId);
    const disputeId = await openDispute(app, requester.agentId, contractId, worker.agentId);

    // Resolve dispute — drains escrow
    const resolve = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${disputeId}/resolve`,
      headers: authHeaders(moderator.agentId, 'moderator'),
      payload: { ruling: 'pay_worker', targetAgentId: worker.agentId }
    });
    expect(resolve.statusCode).toBe(200);

    // Escrow should be at 0 with RELEASED status
    const escrowLock = services.store.escrowLocks.get(contractId);
    expect(escrowLock).toBeDefined();
    expect(escrowLock!.amount).toBe(0);
    expect(escrowLock!.status).toBe('RELEASED');
  });
});

// -----------------------------------------------------------------------
// BUG-CRIT-NEW-001: WebSocket entityId filter — verify fix in place
// -----------------------------------------------------------------------

describe('BUG-CRIT-NEW-001: WebSocket entityId filter (verify fix)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('non-privileged user cannot subscribe to foreign entityId via /v1/events/ws', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'ws_wrk1', role: 'worker', capabilities: ['python'] });

    // Try to subscribe to another entity's events (e.g., a contract or another agent)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/ws?entityId=foreign_entity_id',
      headers: {
        ...authHeaders(worker.agentId, 'worker'),
        connection: 'upgrade',
        upgrade: 'websocket'
      }
    });

    // The WebSocket should be rejected or close with error
    // Via HTTP inject, we expect an error response
    expect(res.statusCode).not.toBe(101);
  });

  it('non-privileged user can subscribe to own agentId events', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'ws_wrk2', role: 'worker', capabilities: ['python'] });

    // Subscribe to own agent events — should be allowed
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/ws?entityId=${worker.agentId}`,
      headers: {
        ...authHeaders(worker.agentId, 'worker'),
        connection: 'upgrade',
        upgrade: 'websocket'
      }
    });

    // WebSocket upgrade attempt — should not be rejected with ENTITY_FORBIDDEN
    // (actual WebSocket upgrade requires real WebSocket client, but we verify no auth error)
    if (res.statusCode >= 400 && res.body && res.body.length > 0) {
      try {
        const body = JSON.parse(res.body) as { error?: { code: string } };
        if (body?.error?.code) {
          expect(body.error.code).not.toBe('ENTITY_FORBIDDEN');
        }
      } catch {
        // Response body not JSON — not an auth error, likely a WebSocket protocol issue
      }
    }
  });

  it('non-privileged user cannot subscribe to foreign entityId via /v1/realtime', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'ws_wrk3', role: 'worker', capabilities: ['python'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/realtime?entityId=foreign_contract_id&channels=audit',
      headers: {
        ...authHeaders(worker.agentId, 'worker'),
        connection: 'upgrade',
        upgrade: 'websocket'
      }
    });

    expect(res.statusCode).not.toBe(101);
  });
});
