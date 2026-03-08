/**
 * TASK-ENFORCE-002: Identity freshness checks on all privileged write routes.
 *
 * Per §5 of docs/enforcement-specification.md, every privileged write route
 * must call enforceFreshIdentity() which blocks operations when the agent's
 * Moltbook verification has expired (>60 minutes since last verify).
 *
 * This test file validates:
 *   1. All 9 privileged write routes reject expired identities with 401 REVERIFY_REQUIRED
 *   2. All 9 routes succeed with fresh identities
 *   3. Admin/moderator roles bypass freshness checks (by design)
 *
 * Routes covered:
 *   1. POST /v1/tasks                                    (task.create)
 *   2. POST /v1/tasks/:id/post                           (task.post)
 *   3. POST /v1/tasks/:id/cancel                         (task.cancel)
 *   4. POST /v1/tasks/:id/reserve                        (task.reserve)
 *   5. POST /v1/tasks/:id/accept                         (task.accept)
 *   6. POST /v1/contracts/:id/milestones/:id/start       (contract.milestone.start)
 *   7. POST /v1/contracts/:id/milestones/:id/deliver     (contract.milestone.deliver)
 *   8. POST /v1/contracts/:id/milestones/:id/accept      (contract.milestone.accept)
 *   9. POST /v1/wallet/payout                            (wallet.payout)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { authHeaders, onboardAgent, topup, createPostedTask } from './helpers.js';

describe('TASK-ENFORCE-002: identity freshness enforcement on privileged write routes', () => {
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

  /** Expire an agent's Moltbook snapshot by setting expiresAt to the past */
  function expireIdentity(agentId: string) {
    const snapshot = services.store.moltbookSnapshots.get(agentId);
    if (snapshot) {
      const expiredAt = new Date(Date.now() - 70 * 60 * 1000).toISOString();
      services.store.moltbookSnapshots.set(agentId, {
        ...snapshot,
        verifiedAt: expiredAt,
        expiresAt: expiredAt
      });
    }
  }

  /** Helper to create a valid task payload */
  function taskPayload() {
    return {
      title: 'Freshness Test Task',
      description: 'Test identity freshness enforcement.',
      pricingMode: 'fixed' as const,
      budget: 100,
      deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      scope: {
        allowedDataRefs: ['dataset://test/input.csv'],
        allowedTools: ['python'],
        egressAllowlist: ['api.test.local'],
        deliverableSchemaRef: 'schema://deliverable/v1',
        acceptanceTestsRef: 'tests://acceptance/v1'
      }
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // 1. POST /v1/tasks (task.create)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/tasks (task.create)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_1', role: 'requester', capabilities: ['orchestrator'] });
      await topup(app, requester.agentId, 'requester', 500);
      expireIdentity(requester.agentId);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: authHeaders(requester.agentId, 'requester'),
        payload: taskPayload()
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });

    it('succeeds with fresh identity', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_1b', role: 'requester', capabilities: ['orchestrator'] });
      await topup(app, requester.agentId, 'requester', 500);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: authHeaders(requester.agentId, 'requester'),
        payload: taskPayload()
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ taskId: string }>().taskId).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. POST /v1/tasks/:id/post (task.post)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/tasks/:id/post (task.post)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_2', role: 'requester', capabilities: ['orchestrator'] });
      await topup(app, requester.agentId, 'requester', 500);

      // Create task while identity is still fresh
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: authHeaders(requester.agentId, 'requester'),
        payload: taskPayload()
      });
      const { taskId } = createRes.json<{ taskId: string }>();

      // Expire identity before posting
      expireIdentity(requester.agentId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${taskId}/post`,
        headers: authHeaders(requester.agentId, 'requester')
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. POST /v1/tasks/:id/cancel (task.cancel)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/tasks/:id/cancel (task.cancel)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_3', role: 'requester', capabilities: ['orchestrator'] });
      await topup(app, requester.agentId, 'requester', 500);
      const task = await createPostedTask(app, requester.agentId, 'python');

      expireIdentity(requester.agentId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/cancel`,
        headers: authHeaders(requester.agentId, 'requester')
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });

    it('succeeds with fresh identity', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_3b', role: 'requester', capabilities: ['orchestrator'] });
      await topup(app, requester.agentId, 'requester', 500);
      const task = await createPostedTask(app, requester.agentId, 'python');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/cancel`,
        headers: authHeaders(requester.agentId, 'requester')
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. POST /v1/tasks/:id/reserve (task.reserve)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/tasks/:id/reserve (task.reserve)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_4', role: 'requester', capabilities: ['orchestrator'] });
      const worker = await onboardAgent(app, { tokenSeed: 'fresh_wrk_4', role: 'worker', capabilities: ['python'] });
      await topup(app, requester.agentId, 'requester', 500);
      const task = await createPostedTask(app, requester.agentId, 'python');

      // Worker bids
      await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/bids`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: { rate: 100 }
      });

      // Expire worker's identity before reserving
      expireIdentity(worker.agentId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/reserve`,
        headers: authHeaders(worker.agentId, 'worker')
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. POST /v1/tasks/:id/accept (task.accept)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/tasks/:id/accept (task.accept)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_5', role: 'requester', capabilities: ['orchestrator'] });
      const worker = await onboardAgent(app, { tokenSeed: 'fresh_wrk_5', role: 'worker', capabilities: ['python'] });
      await topup(app, requester.agentId, 'requester', 500);
      const task = await createPostedTask(app, requester.agentId, 'python');

      // Worker bids and reserves
      await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/bids`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: { rate: 100 }
      });
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/reserve`,
        headers: authHeaders(worker.agentId, 'worker')
      });
      const lease = reserveRes.json<{ leaseId: string; leaseToken: string }>();

      // Expire requester's identity before accepting
      expireIdentity(requester.agentId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/accept`,
        headers: authHeaders(requester.agentId, 'requester'),
        payload: lease
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 6. POST /v1/contracts/:id/milestones/:id/start (contract.milestone.start)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/contracts/:id/milestones/:id/start (contract.milestone.start)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_6', role: 'requester', capabilities: ['orchestrator'] });
      const worker = await onboardAgent(app, { tokenSeed: 'fresh_wrk_6', role: 'worker', capabilities: ['python'] });
      await topup(app, requester.agentId, 'requester', 500);
      const task = await createPostedTask(app, requester.agentId, 'python');

      // Bid → reserve → accept → contract
      await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/bids`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: { rate: 100 }
      });
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/reserve`,
        headers: authHeaders(worker.agentId, 'worker')
      });
      const lease = reserveRes.json<{ leaseId: string; leaseToken: string }>();
      const acceptRes = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/accept`,
        headers: authHeaders(requester.agentId, 'requester'),
        payload: lease
      });
      const contract = acceptRes.json<{
        contractId: string;
        milestones: { milestoneId: string }[];
      }>();

      // Expire worker's identity before starting milestone
      expireIdentity(worker.agentId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/milestones/${contract.milestones[0].milestoneId}/start`,
        headers: authHeaders(worker.agentId, 'worker')
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7. POST /v1/contracts/:id/milestones/:id/deliver (contract.milestone.deliver)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/contracts/:id/milestones/:id/deliver (contract.milestone.deliver)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_7', role: 'requester', capabilities: ['orchestrator'] });
      const worker = await onboardAgent(app, { tokenSeed: 'fresh_wrk_7', role: 'worker', capabilities: ['python'] });
      await topup(app, requester.agentId, 'requester', 500);
      const task = await createPostedTask(app, requester.agentId, 'python');

      // Full flow: bid → reserve → accept → contract
      await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/bids`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: { rate: 100 }
      });
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/reserve`,
        headers: authHeaders(worker.agentId, 'worker')
      });
      const lease = reserveRes.json<{ leaseId: string; leaseToken: string }>();
      const acceptRes = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/accept`,
        headers: authHeaders(requester.agentId, 'requester'),
        payload: lease
      });
      const contract = acceptRes.json<{
        contractId: string;
        milestones: { milestoneId: string }[];
      }>();

      // Get signature while identity is fresh
      const sigPreview = await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/signature-preview`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: {
          milestoneId: contract.milestones[0].milestoneId,
          content: 'test-deliverable'
        }
      });
      const { signature } = sigPreview.json<{ signature: string }>();

      // Expire worker's identity before delivering
      expireIdentity(worker.agentId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/milestones/${contract.milestones[0].milestoneId}/deliver`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: {
          content: 'test-deliverable',
          signature
        }
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 8. POST /v1/contracts/:id/milestones/:id/accept (contract.milestone.accept)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/contracts/:id/milestones/:id/accept (contract.milestone.accept)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_8', role: 'requester', capabilities: ['orchestrator'] });
      const worker = await onboardAgent(app, { tokenSeed: 'fresh_wrk_8', role: 'worker', capabilities: ['python'] });
      await topup(app, requester.agentId, 'requester', 500);
      const task = await createPostedTask(app, requester.agentId, 'python');

      // Full flow: bid → reserve → accept → contract → deliver
      await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/bids`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: { rate: 100 }
      });
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/reserve`,
        headers: authHeaders(worker.agentId, 'worker')
      });
      const lease = reserveRes.json<{ leaseId: string; leaseToken: string }>();
      const acceptRes = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/accept`,
        headers: authHeaders(requester.agentId, 'requester'),
        payload: lease
      });
      const contract = acceptRes.json<{
        contractId: string;
        milestones: { milestoneId: string }[];
      }>();

      // Worker delivers milestone
      const sigPreview = await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/signature-preview`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: {
          milestoneId: contract.milestones[0].milestoneId,
          content: 'test-deliverable'
        }
      });
      const { signature } = sigPreview.json<{ signature: string }>();

      await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/milestones/${contract.milestones[0].milestoneId}/deliver`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: {
          content: 'test-deliverable',
          signature
        }
      });

      // Expire requester's identity before accepting
      expireIdentity(requester.agentId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/milestones/${contract.milestones[0].milestoneId}/accept`,
        headers: authHeaders(requester.agentId, 'requester')
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 9. POST /v1/wallet/payout (wallet.payout)
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/wallet/payout (wallet.payout)', () => {
    it('rejects with expired identity → 401 REVERIFY_REQUIRED', async () => {
      const worker = await onboardAgent(app, { tokenSeed: 'fresh_wrk_9', role: 'worker', capabilities: ['python'] });

      expireIdentity(worker.agentId);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/wallet/payout',
        headers: authHeaders(worker.agentId, 'worker'),
        payload: { amount: 10 }
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REVERIFY_REQUIRED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Admin/moderator bypass tests
  // ────────────────────────────────────────────────────────────────────────

  describe('admin and moderator bypass freshness checks', () => {
    it('admin can create task with expired identity', async () => {
      const admin = await onboardAgent(app, { tokenSeed: 'fresh_admin_1', role: 'admin', capabilities: ['orchestrator'] });
      await topup(app, admin.agentId, 'admin', 500);
      expireIdentity(admin.agentId);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: authHeaders(admin.agentId, 'admin'),
        payload: taskPayload()
      });

      // Admin bypasses freshness — should not get 401 REVERIFY_REQUIRED
      expect(res.statusCode).not.toBe(401);
    });

    it('moderator can cancel task with expired identity', async () => {
      const requester = await onboardAgent(app, { tokenSeed: 'fresh_req_mod', role: 'requester', capabilities: ['orchestrator'] });
      const moderator = await onboardAgent(app, { tokenSeed: 'fresh_mod_1', role: 'moderator', capabilities: ['orchestrator'] });
      await topup(app, requester.agentId, 'requester', 500);
      const task = await createPostedTask(app, requester.agentId, 'python');

      expireIdentity(moderator.agentId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.taskId}/cancel`,
        headers: authHeaders(moderator.agentId, 'moderator')
      });

      // Moderator bypasses freshness — should not get 401 REVERIFY_REQUIRED
      expect(res.statusCode).not.toBe(401);
    });
  });
});
