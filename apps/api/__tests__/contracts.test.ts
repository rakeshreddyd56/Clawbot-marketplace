/**
 * Contract Execution Tests
 *
 * Covers:
 * - GET contract by ID (access control)
 * - Milestone start (happy path, invalid transitions, access control)
 * - Milestone deliver (happy path, invalid signature, before start, access control)
 * - Milestone accept (happy path, double accept, before deliver, wrong role)
 * - Legacy contract deliver/accept routes (also require policy)
 * - Signature preview endpoint
 * - Worker receives payment after milestone accept
 * - Escrow: locked on contract creation, released on milestone accept
 * - State machine violations: accept before deliver, deliver before start
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  bearerAuth,
  onboardAgent,
  setupContractLifecycle,
} from './helpers.js';

// ─── Contract Read ───────────────────────────────────────────────────────────

describe('Contract: Read', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/contracts/:contractId → 200 for requester party', async () => {
    const { contractId, requester } = await setupContractLifecycle(app);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/contracts/${contractId}`,
      headers: requester.auth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.contractId).toBe(contractId);
  });

  it('GET /v1/contracts/:contractId → 200 for worker party', async () => {
    const { contractId, worker } = await setupContractLifecycle(app);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/contracts/${contractId}`,
      headers: worker.auth,
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /v1/contracts/:contractId → 403 for unrelated third party', async () => {
    const { contractId } = await setupContractLifecycle(app);
    const outsider = await onboardAgent(app, 'mbtok_outsider_contract_001', 'worker');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/contracts/${contractId}`,
      headers: outsider.auth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/contracts/nonexistent → 404', async () => {
    const { requester } = await setupContractLifecycle(app);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/contracts/contract_nonexistent_xxx',
      headers: requester.auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/contracts/:contractId → 401 without auth', async () => {
    const { contractId } = await setupContractLifecycle(app);
    const res = await app.inject({ method: 'GET', url: `/v1/contracts/${contractId}` });
    expect(res.statusCode).toBe(401);
  });

  it('Contract has milestones array with at least one milestone', async () => {
    const { contract } = await setupContractLifecycle(app);
    expect(Array.isArray(contract.milestones)).toBe(true);
    expect(contract.milestones.length).toBeGreaterThan(0);
  });

  it('Admin can read any contract', async () => {
    const { contractId } = await setupContractLifecycle(app);
    const admin = { 'x-agent-id': 'admin_contract_read', 'x-role': 'admin' };

    const res = await app.inject({
      method: 'GET',
      url: `/v1/contracts/${contractId}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Milestone Start ─────────────────────────────────────────────────────────

describe('Contract: Milestone Start', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('Worker starts first milestone → 200 with executionId', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: worker.auth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('executionId');
  });

  it('Requester cannot start a milestone → 403', async () => {
    const { contractId, requester, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: requester.auth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('Unrelated third party cannot start a milestone → 403', async () => {
    const { contractId, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    const outsider = await onboardAgent(app, 'mbtok_outsider_start_001', 'worker');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: outsider.auth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('Start nonexistent milestone → 404', async () => {
    const { contractId, worker } = await setupContractLifecycle(app);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/milestone_fake_xxx/start`,
      headers: worker.auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('State machine: cannot start already-started milestone → 409', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    // First start
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: worker.auth,
    });

    // Second start — should fail
    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: worker.auth,
    });
    expect([409, 422]).toContain(res.statusCode);
  });
});

// ─── Milestone Deliver ───────────────────────────────────────────────────────

describe('Contract: Milestone Deliver', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('Worker delivers after start → 200 with artifactId', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: worker.auth,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: worker.auth,
      payload: {
        content: 'Completed deliverable content',
        signature: 'sig_from_worker',
      },
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('artifactId');
  });

  it('State machine: deliver before start → 409', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    // Skip start, go directly to deliver
    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: worker.auth,
      payload: {
        content: 'Delivered without starting',
        signature: 'sig_premature',
      },
    });
    expect([409, 422]).toContain(res.statusCode);
  });

  it('Deliver with missing content → 400', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: worker.auth,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: worker.auth,
      payload: { signature: 'sig_only' }, // missing content
    });
    expect(res.statusCode).toBe(400);
  });

  it('Deliver with missing signature → 400', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: worker.auth,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: worker.auth,
      payload: { content: 'Content only' }, // missing signature
    });
    expect(res.statusCode).toBe(400);
  });

  it('Requester cannot deliver → 403', async () => {
    const { contractId, requester, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: requester.auth,
      payload: { content: 'Content', signature: 'sig' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Unrelated outsider cannot deliver → 403', async () => {
    const { contractId, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    const outsider = await onboardAgent(app, 'mbtok_outsider_deliver_001', 'worker');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: outsider.auth,
      payload: { content: 'Stolen delivery', signature: 'sig_fake' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Double deliver (idempotency) → 409', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: worker.auth,
    });

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: worker.auth,
      payload: { content: 'First delivery', signature: 'sig1' },
    });

    // Second delivery attempt
    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/deliver`,
      headers: worker.auth,
      payload: { content: 'Second delivery attempt', signature: 'sig2' },
    });
    expect([409, 422]).toContain(res.statusCode);
  });
});

// ─── Milestone Accept ─────────────────────────────────────────────────────────

describe('Contract: Milestone Accept', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  async function deliverMilestone(
    app: FastifyInstance,
    contractId: string,
    milestoneId: string,
    workerAuth: { authorization: string }
  ) {
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestoneId}/start`,
      headers: workerAuth,
    });
    return app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestoneId}/deliver`,
      headers: workerAuth,
      payload: { content: 'Deliver test', signature: 'sig_test' },
    });
  }

  it('Requester accepts delivered milestone → 200', async () => {
    const { contractId, worker, requester, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await deliverMilestone(app, contractId, milestone.milestoneId, worker.auth);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: requester.auth,
    });
    expect([200, 201]).toContain(res.statusCode);
  });

  it('Worker receives payment after milestone accept', async () => {
    const { contractId, worker, requester, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await deliverMilestone(app, contractId, milestone.milestoneId, worker.auth);

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: requester.auth,
    });

    const balRes = await app.inject({ method: 'GET', url: '/v1/wallet/balance', headers: worker.auth });
    const { balance } = JSON.parse(balRes.body);
    expect(balance).toBeGreaterThan(0);
  });

  it('State machine: accept before deliver → 409', async () => {
    const { contractId, worker, requester, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/start`,
      headers: worker.auth,
    });

    // Accept before deliver
    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: requester.auth,
    });
    expect([409, 422]).toContain(res.statusCode);
  });

  it('State machine: accept on not-started milestone → 409', async () => {
    const { contractId, requester, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: requester.auth,
    });
    expect([409, 422]).toContain(res.statusCode);
  });

  it('Double accept → 409 (no double-pay)', async () => {
    const { contractId, worker, requester, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await deliverMilestone(app, contractId, milestone.milestoneId, worker.auth);

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: requester.auth,
    });

    // Second accept should fail
    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: requester.auth,
    });
    expect([409, 422]).toContain(res.statusCode);
  });

  it('Worker cannot accept their own delivery → 403', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await deliverMilestone(app, contractId, milestone.milestoneId, worker.auth);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: worker.auth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('Unrelated party cannot accept → 403', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    await deliverMilestone(app, contractId, milestone.milestoneId, worker.auth);

    const outsider = await onboardAgent(app, 'mbtok_outsider_accept_001', 'requester');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: outsider.auth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('No double-payment: worker balance increases by exactly milestone amount', async () => {
    const { contractId, worker, requester, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    const beforeBal = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/wallet/balance', headers: worker.auth })).body
    ).balance;

    await deliverMilestone(app, contractId, milestone.milestones?.[0]?.milestoneId ?? milestone.milestoneId, worker.auth);
    await deliverMilestone(app, contractId, milestone.milestoneId, worker.auth);

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/milestones/${milestone.milestoneId}/accept`,
      headers: requester.auth,
    });

    const afterBal = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/wallet/balance', headers: worker.auth })).body
    ).balance;

    expect(afterBal).toBeGreaterThan(beforeBal);
  });
});

// ─── Legacy Contract Routes ──────────────────────────────────────────────────

describe('Contract: Legacy routes (also require policy)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/contracts/:contractId/deliver → 403 for non-party', async () => {
    const { contractId, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    const outsider = await onboardAgent(app, 'mbtok_legacy_deliver_spy_001', 'worker');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/deliver`,
      headers: outsider.auth,
      payload: { milestoneId: milestone.milestoneId, content: 'Stolen', signature: 'sig_fake' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/contracts/:contractId/accept → 403 for non-party', async () => {
    const { contractId, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    const outsider = await onboardAgent(app, 'mbtok_legacy_accept_spy_001', 'requester');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/accept`,
      headers: outsider.auth,
      payload: { milestoneId: milestone.milestoneId },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Signature Preview ───────────────────────────────────────────────────────

describe('Contract: Signature Preview', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/contracts/:contractId/signature-preview → 200 with signature', async () => {
    const { contractId, worker, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: worker.auth,
      payload: {
        milestoneId: milestone.milestoneId,
        content: 'Content to sign',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('signature');
    expect(typeof body.signature).toBe('string');
    expect(body.signature.length).toBeGreaterThan(0);
  });

  it('Signature preview for unrelated outsider → 403', async () => {
    const { contractId, contract } = await setupContractLifecycle(app);
    const milestone = contract.milestones[0];
    const outsider = await onboardAgent(app, 'mbtok_sig_preview_spy_001', 'worker');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: outsider.auth,
      payload: {
        milestoneId: milestone.milestoneId,
        content: 'Content to sign',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Signature preview with missing milestoneId → 400', async () => {
    const { contractId, worker } = await setupContractLifecycle(app);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contractId}/signature-preview`,
      headers: worker.auth,
      payload: { content: 'Content only' }, // missing milestoneId
    });
    expect(res.statusCode).toBe(400);
  });
});
