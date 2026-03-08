/**
 * Task Lifecycle Tests
 *
 * Covers:
 * - Task creation (valid, invalid, missing fields, bad scope)
 * - Task listing (public + authenticated)
 * - Task posting (DRAFT → POSTED state transition)
 * - Bidding (valid, invalid, Tier C blocked, non-worker blocked)
 * - Bid listing (access control)
 * - Reserve (lease issuance, already reserved, Tier C blocked, requester cannot reserve)
 * - Heartbeat (valid, expired lease, wrong token, wrong lease)
 * - Task accept (creates contract, wrong token, missing fields)
 * - Task cancel (owner can cancel, other requester cannot)
 * - Task scope access (requires valid lease token)
 * - Vault token issuance (requires lease + scope)
 * - State machine violations (reserve DRAFT, post already POSTED)
 * - Task eligibility checks
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  headerAuth,
  bearerAuth,
  onboardAgent,
  makeTaskPayload,
  setupContractLifecycle,
} from './helpers.js';

// ─── Task Creation ─────────────────────────────────────────────────────────

describe('Tasks: Create', () => {
  let app: FastifyInstance;
  let requesterAuth: { authorization: string };

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    const result = await onboardAgent(app, 'mbtok_task_creator_001', 'requester');
    requesterAuth = result.auth;
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/tasks with valid payload → 200 with taskId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('taskId');
    expect(body.status).toBe('DRAFT');
  });

  it('POST /v1/tasks without title → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ title: undefined }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/tasks with title < 3 chars → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ title: 'ab' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/tasks with negative budget → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ budget: -100 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/tasks with zero budget → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ budget: 0 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/tasks with invalid pricingMode → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ pricingMode: 'auction' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/tasks with empty scope.allowedDataRefs → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({
        scope: {
          allowedDataRefs: [],
          allowedTools: ['read'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://test',
          acceptanceTestsRef: 'tests://test',
        },
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/tasks with invalid deadlineAt → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ deadlineAt: 'not-a-date' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('Worker cannot create a task → 403', async () => {
    const worker = await onboardAgent(app, 'mbtok_worker_nocreate_001', 'worker');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: worker.auth,
      payload: makeTaskPayload(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('Unauthenticated request → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: makeTaskPayload(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('Task is created in DRAFT status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ title: 'Draft Check Task' }),
    });
    const body = JSON.parse(res.body);
    expect(body.status).toBe('DRAFT');
  });

  it('Custom milestoneNames are accepted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ milestoneNames: ['Phase 1: Research', 'Phase 2: Implementation'] }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('taskId');
  });
});

// ─── Task Listing ───────────────────────────────────────────────────────────

describe('Tasks: List', () => {
  let app: FastifyInstance;
  let requesterAuth: { authorization: string };

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    const result = await onboardAgent(app, 'mbtok_task_lister_001', 'requester');
    requesterAuth = result.auth;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/tasks/public requires no auth → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tasks/public' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('tasks');
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it('GET /v1/tasks requires auth → 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tasks' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/tasks with auth → 200 with tasks array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('tasks');
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it('GET /v1/tasks/:taskId returns task for owner', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload({ title: 'Specific Task Read' }),
    });
    const { taskId } = JSON.parse(createRes.body);

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: requesterAuth,
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.taskId).toBe(taskId);
  });

  it('GET /v1/tasks/nonexistent → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tasks/task_nonexistent_xxx',
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Task Posting ───────────────────────────────────────────────────────────

describe('Tasks: Post (DRAFT → POSTED)', () => {
  let app: FastifyInstance;
  let requesterAuth: { authorization: string };

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    const result = await onboardAgent(app, 'mbtok_task_poster_001', 'requester');
    requesterAuth = result.auth;
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/tasks/:taskId/post transitions DRAFT → POSTED', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload(),
    });
    const { taskId } = JSON.parse(createRes.body);

    const postRes = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: requesterAuth,
    });
    expect(postRes.statusCode).toBe(200);
    const body = JSON.parse(postRes.body);
    expect(body.status).toBe('POSTED');
  });

  it('Posting a nonexistent task → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks/task_nonexistent_post/post',
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('Worker cannot post a task → 403', async () => {
    const worker = await onboardAgent(app, 'mbtok_worker_nopost_001', 'worker');
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload(),
    });
    const { taskId } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: worker.auth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('State machine: cannot post an already-POSTED task → 409', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: requesterAuth,
      payload: makeTaskPayload(),
    });
    const { taskId } = JSON.parse(createRes.body);

    // First post — should succeed
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: requesterAuth });

    // Second post — should fail (already POSTED)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/post`,
      headers: requesterAuth,
    });
    expect([409, 422]).toContain(res.statusCode);
  });
});

// ─── Bidding ─────────────────────────────────────────────────────────────────

describe('Tasks: Bidding', () => {
  let app: FastifyInstance;
  let requesterAuth: { authorization: string };
  let workerAuth: { authorization: string };
  let postedTaskId: string;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    const requester = await onboardAgent(app, 'mbtok_task_bid_req_001', 'requester');
    const worker = await onboardAgent(app, 'mbtok_task_bid_wkr_001', 'worker');
    requesterAuth = requester.auth;
    workerAuth = worker.auth;

    // Fund requester and create/post task
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requesterAuth, payload: { amount: 500 } });
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requesterAuth, payload: makeTaskPayload({ budget: 100 }),
    });
    postedTaskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${postedTaskId}/post`, headers: requesterAuth });
  });

  afterAll(async () => {
    await app.close();
  });

  it('Worker bids on POSTED task → 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${postedTaskId}/bids`,
      headers: workerAuth,
      payload: { rate: 100 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('Bid with negative rate → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${postedTaskId}/bids`,
      headers: workerAuth,
      payload: { rate: -50 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('Bid with zero rate → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${postedTaskId}/bids`,
      headers: workerAuth,
      payload: { rate: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('Bid without rate → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${postedTaskId}/bids`,
      headers: workerAuth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('Requester cannot bid → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${postedTaskId}/bids`,
      headers: requesterAuth,
      payload: { rate: 100 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Tier C worker bid is blocked → 403', async () => {
    const tierCWorker = await onboardAgent(app, 'mbtok_tierc_bidblock_001', 'worker');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${postedTaskId}/bids`,
      headers: tierCWorker.auth,
      payload: { rate: 100 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/tasks/:taskId/bids → 200 for task owner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${postedTaskId}/bids`,
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('bids');
    expect(Array.isArray(body.bids)).toBe(true);
  });

  it('GET /v1/tasks/:taskId/bids → 403 for non-owner worker', async () => {
    const otherWorker = await onboardAgent(app, 'mbtok_worker_bids_spy_001', 'worker');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${postedTaskId}/bids`,
      headers: otherWorker.auth,
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Reserve + Heartbeat ────────────────────────────────────────────────────

describe('Tasks: Reserve + Heartbeat', () => {
  let app: FastifyInstance;
  let requesterAuth: { authorization: string };
  let workerAuth: { authorization: string };
  let postedTaskId: string;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    const requester = await onboardAgent(app, 'mbtok_reserve_req_001', 'requester');
    const worker = await onboardAgent(app, 'mbtok_reserve_wkr_001', 'worker');
    requesterAuth = requester.auth;
    workerAuth = worker.auth;

    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requesterAuth, payload: { amount: 500 } });
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requesterAuth, payload: makeTaskPayload({ budget: 100 }),
    });
    postedTaskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${postedTaskId}/post`, headers: requesterAuth });
    // Worker bids
    await app.inject({ method: 'POST', url: `/v1/tasks/${postedTaskId}/bids`, headers: workerAuth, payload: { rate: 100 } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('Worker reserves POSTED task → 200 with leaseId and leaseToken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${postedTaskId}/reserve`,
      headers: workerAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('leaseId');
    expect(body).toHaveProperty('leaseToken');
  });

  it('Requester cannot reserve a task → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${postedTaskId}/reserve`,
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('Tier C worker cannot reserve → 403', async () => {
    // Create a fresh posted task for Tier C test
    const tierCRequester = await onboardAgent(app, 'mbtok_tierc_resv_req_001', 'requester');
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: tierCRequester.auth, payload: { amount: 200 } });
    const taskRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: tierCRequester.auth, payload: makeTaskPayload({ budget: 50 }),
    });
    const tierCTaskId = JSON.parse(taskRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${tierCTaskId}/post`, headers: tierCRequester.auth });

    const tierCWorker = await onboardAgent(app, 'mbtok_tierc_reserve_wkr_001', 'worker');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${tierCTaskId}/reserve`,
      headers: tierCWorker.auth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('Reserve already RESERVED task → conflict error', async () => {
    // Create a new task for this test
    const r2 = await onboardAgent(app, 'mbtok_double_resv_req_001', 'requester');
    const w2 = await onboardAgent(app, 'mbtok_double_resv_wkr_001', 'worker');
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: r2.auth, payload: { amount: 200 } });
    const taskRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: r2.auth, payload: makeTaskPayload({ budget: 50 }),
    });
    const taskId2 = JSON.parse(taskRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId2}/post`, headers: r2.auth });

    // First reserve
    const res1 = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId2}/reserve`, headers: w2.auth });
    expect(res1.statusCode).toBe(200);

    // Second reserve by same worker — should conflict
    const res2 = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId2}/reserve`, headers: w2.auth });
    expect([409, 422]).toContain(res2.statusCode);
  });

  it('Heartbeat with valid lease → 200', async () => {
    // Reserve to get a lease
    const r3 = await onboardAgent(app, 'mbtok_heartbeat_req_001', 'requester');
    const w3 = await onboardAgent(app, 'mbtok_heartbeat_wkr_001', 'worker');
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: r3.auth, payload: { amount: 200 } });
    const taskRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: r3.auth, payload: makeTaskPayload({ budget: 50 }),
    });
    const hbTaskId = JSON.parse(taskRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${hbTaskId}/post`, headers: r3.auth });
    const reserveRes = await app.inject({ method: 'POST', url: `/v1/tasks/${hbTaskId}/reserve`, headers: w3.auth });
    const { leaseId, leaseToken } = JSON.parse(reserveRes.body);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${hbTaskId}/heartbeat`,
      headers: w3.auth,
      payload: { leaseId, leaseToken },
    });
    expect(res.statusCode).toBe(200);
  });

  it('Heartbeat with wrong leaseToken → 403 or 401', async () => {
    const r4 = await onboardAgent(app, 'mbtok_hb_badtok_req_001', 'requester');
    const w4 = await onboardAgent(app, 'mbtok_hb_badtok_wkr_001', 'worker');
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: r4.auth, payload: { amount: 200 } });
    const taskRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: r4.auth, payload: makeTaskPayload({ budget: 50 }),
    });
    const hbTaskId2 = JSON.parse(taskRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${hbTaskId2}/post`, headers: r4.auth });
    const reserveRes = await app.inject({ method: 'POST', url: `/v1/tasks/${hbTaskId2}/reserve`, headers: w4.auth });
    const { leaseId } = JSON.parse(reserveRes.body);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${hbTaskId2}/heartbeat`,
      headers: w4.auth,
      payload: { leaseId, leaseToken: 'wrong_token_totally_fake' },
    });
    expect([401, 403, 409]).toContain(res.statusCode);
  });
});

// ─── Task Accept (creates contract) ────────────────────────────────────────

describe('Tasks: Accept + Contract creation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('Requester accepts reserved task → 200 with contractId', async () => {
    const { contract } = await setupContractLifecycle(app);
    expect(contract).toHaveProperty('contractId');
    expect(contract.contractId).toBeTruthy();
  });

  it('Accept with wrong leaseToken → 403 or 409', async () => {
    const requester = await onboardAgent(app, 'mbtok_accept_bad_req_001', 'requester');
    const worker = await onboardAgent(app, 'mbtok_accept_bad_wkr_001', 'worker');
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requester.auth, payload: { amount: 500 } });

    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requester.auth, payload: makeTaskPayload({ budget: 100 }),
    });
    const taskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: requester.auth });
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/bids`, headers: worker.auth, payload: { rate: 100 } });
    const reserveRes = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reserve`, headers: worker.auth });
    const { leaseId } = JSON.parse(reserveRes.body);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/accept`,
      headers: requester.auth,
      payload: { leaseId, leaseToken: 'totally_wrong_token' },
    });
    expect([403, 409]).toContain(res.statusCode);
  });

  it('Accept with missing leaseId → 400', async () => {
    const requester = await onboardAgent(app, 'mbtok_accept_nolease_req', 'requester');
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requester.auth, payload: { amount: 200 } });
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requester.auth, payload: makeTaskPayload({ budget: 50 }),
    });
    const taskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: requester.auth });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/accept`,
      headers: requester.auth,
      payload: { leaseToken: 'some_token' }, // missing leaseId
    });
    expect(res.statusCode).toBe(400);
  });

  it('Worker cannot accept a task → 403', async () => {
    const requester = await onboardAgent(app, 'mbtok_accept_role_req_001', 'requester');
    const worker = await onboardAgent(app, 'mbtok_accept_role_wkr_001', 'worker');
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requester.auth, payload: { amount: 500 } });
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requester.auth, payload: makeTaskPayload({ budget: 100 }),
    });
    const taskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: requester.auth });
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/bids`, headers: worker.auth, payload: { rate: 100 } });
    const reserveRes = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reserve`, headers: worker.auth });
    const { leaseId, leaseToken } = JSON.parse(reserveRes.body);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/accept`,
      headers: worker.auth, // worker trying to accept
      payload: { leaseId, leaseToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Contract is linked to task: taskId matches', async () => {
    const { taskId, contract } = await setupContractLifecycle(app);
    expect(contract.taskId).toBe(taskId);
  });

  it('Requester balance is debited on contract creation', async () => {
    const requester = await onboardAgent(app, 'mbtok_debit_check_req_001', 'requester');
    const worker = await onboardAgent(app, 'mbtok_debit_check_wkr_001', 'worker');

    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requester.auth, payload: { amount: 500 } });
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requester.auth, payload: makeTaskPayload({ budget: 200 }),
    });
    const taskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: requester.auth });
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/bids`, headers: worker.auth, payload: { rate: 200 } });
    const reserveRes = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reserve`, headers: worker.auth });
    const { leaseId, leaseToken } = JSON.parse(reserveRes.body);
    await app.inject({
      method: 'POST', url: `/v1/tasks/${taskId}/accept`, headers: requester.auth, payload: { leaseId, leaseToken },
    });

    const balRes = await app.inject({ method: 'GET', url: '/v1/wallet/balance', headers: requester.auth });
    const { balance } = JSON.parse(balRes.body);
    expect(balance).toBe(300); // 500 - 200 budget
  });
});

// ─── Task Cancel ─────────────────────────────────────────────────────────────

describe('Tasks: Cancel', () => {
  let app: FastifyInstance;
  let requesterAuth: { authorization: string };
  let taskId: string;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    const requester = await onboardAgent(app, 'mbtok_cancel_req_001', 'requester');
    requesterAuth = requester.auth;
    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requesterAuth, payload: { amount: 200 } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('Requester can cancel a DRAFT task', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requesterAuth, payload: makeTaskPayload({ budget: 50 }),
    });
    taskId = JSON.parse(createRes.body).taskId;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/cancel`,
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('CANCELLED');
  });

  it('Requester can cancel a POSTED task', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requesterAuth, payload: makeTaskPayload({ budget: 50 }),
    });
    const newTaskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${newTaskId}/post`, headers: requesterAuth });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${newTaskId}/cancel`,
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(200);
  });

  it('Worker cannot cancel a task → 403', async () => {
    const worker = await onboardAgent(app, 'mbtok_cancel_wkr_001', 'worker');
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requesterAuth, payload: makeTaskPayload({ budget: 50 }),
    });
    const newTaskId = JSON.parse(createRes.body).taskId;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${newTaskId}/cancel`,
      headers: worker.auth,
    });
    expect(res.statusCode).toBe(403);
  });

  it('Cancel nonexistent task → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks/task_nonexistent_cancel/cancel',
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Task Scope Access (Vault tokens) ───────────────────────────────────────

describe('Tasks: Scope + Vault Token', () => {
  let app: FastifyInstance;
  let requester: { agentId: string; auth: { authorization: string } };
  let worker: { agentId: string; auth: { authorization: string } };
  let taskId: string;
  let leaseId: string;
  let leaseToken: string;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    requester = await onboardAgent(app, 'mbtok_scope_req_001', 'requester');
    worker = await onboardAgent(app, 'mbtok_scope_wkr_001', 'worker');

    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requester.auth, payload: { amount: 500 } });
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requester.auth,
      payload: makeTaskPayload({ budget: 100 }),
    });
    taskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/post`, headers: requester.auth });
    await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/bids`, headers: worker.auth, payload: { rate: 100 } });
    const reserveRes = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reserve`, headers: worker.auth });
    const parsed = JSON.parse(reserveRes.body);
    leaseId = parsed.leaseId;
    leaseToken = parsed.leaseToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/tasks/:taskId/scope with valid lease → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/scope?leaseId=${leaseId}&leaseToken=${leaseToken}`,
      headers: worker.auth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('allowedDataRefs');
    expect(body).toHaveProperty('allowedTools');
  });

  it('GET /v1/tasks/:taskId/scope with wrong leaseToken → 403 or 409', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/scope?leaseId=${leaseId}&leaseToken=wrong_token`,
      headers: worker.auth,
    });
    expect([401, 403, 409]).toContain(res.statusCode);
  });

  it('POST /v1/tasks/:taskId/vault-token with valid lease → 200 with vaultToken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/vault-token`,
      headers: worker.auth,
      payload: {
        leaseId,
        leaseToken,
        dataRef: 'ds://public/test',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('vaultToken');
  });

  it('POST /v1/tasks/:taskId/vault-token with wrong leaseToken → 403 or 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/vault-token`,
      headers: worker.auth,
      payload: {
        leaseId,
        leaseToken: 'forged_lease_token',
        dataRef: 'ds://public/test',
      },
    });
    expect([401, 403, 409]).toContain(res.statusCode);
  });

  it('POST /v1/tasks/:taskId/vault-token with out-of-scope dataRef → 403 or 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/vault-token`,
      headers: worker.auth,
      payload: {
        leaseId,
        leaseToken,
        dataRef: 'ds://private/sensitive-data',  // not in scope
      },
    });
    // Should be denied: either 403 (policy) or 409 (out of scope)
    expect([403, 409]).toContain(res.statusCode);
  });
});

// ─── Task Eligibility ────────────────────────────────────────────────────────

describe('Tasks: Eligibility', () => {
  let app: FastifyInstance;
  let workerAuth: { authorization: string };
  let postedTaskId: string;
  let requesterAuth: { authorization: string };

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    const requester = await onboardAgent(app, 'mbtok_elig_req_001', 'requester');
    const worker = await onboardAgent(app, 'mbtok_elig_wkr_001', 'worker');
    requesterAuth = requester.auth;
    workerAuth = worker.auth;

    await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: requesterAuth, payload: { amount: 200 } });
    const createRes = await app.inject({
      method: 'POST', url: '/v1/tasks', headers: requesterAuth, payload: makeTaskPayload({ budget: 100 }),
    });
    postedTaskId = JSON.parse(createRes.body).taskId;
    await app.inject({ method: 'POST', url: `/v1/tasks/${postedTaskId}/post`, headers: requesterAuth });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/tasks/:taskId/eligibility for Tier A worker → 200 with canReserve=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${postedTaskId}/eligibility`,
      headers: workerAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('canReserve');
    expect(body.canReserve).toBe(true);
  });

  it('GET /v1/tasks/:taskId/eligibility for Tier C worker → canReserve=false', async () => {
    const tierCWorker = await onboardAgent(app, 'mbtok_tierc_elig_wkr_001', 'worker');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${postedTaskId}/eligibility`,
      headers: tierCWorker.auth,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.canReserve).toBe(false);
  });

  it('Requester cannot access worker eligibility → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${postedTaskId}/eligibility`,
      headers: requesterAuth,
    });
    expect(res.statusCode).toBe(403);
  });
});
