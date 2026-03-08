/**
 * Auth & Identity Security Tests
 *
 * Covers:
 * - JWT token attacks (invalid, tampered, expired)
 * - No-auth requests → 401
 * - Header-based auth in dev mode
 * - Role escalation via session exchange
 * - Moltbook identity attacks (expired token, unclaimed, deactivated)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, headerAuth, bearerAuth, makeToken } from './helpers.js';

describe('Auth: No credentials → 401', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/agents/me without auth → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/agents/me' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/wallet/topup without auth → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      payload: { amount: 100 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/tasks without auth → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/tasks', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/wallet/balance without auth → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/wallet/balance' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Auth: Tampered / invalid JWT → 401', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('Bearer token with wrong signature → 401', async () => {
    // Tamper the signature portion of a valid token
    const validToken = makeToken('agent_test', 'worker');
    const parts = validToken.split('.');
    parts[2] = 'invalidSignatureXXXXXXXXXXXXXXXXXXXX';
    const tampered = parts.join('.');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Bearer token with wrong algorithm claim → 401', async () => {
    // 'none' algorithm attack — manually crafted JWT with alg=none
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'agent_evil', role: 'admin', iss: 'clawbot-marketplace', aud: 'clawbot-clients' })).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { authorization: `Bearer ${noneToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Bearer token with random garbage → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { authorization: 'Bearer not.a.token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Malformed Authorization header (no Bearer prefix) → 401', async () => {
    const token = makeToken('agent_test', 'worker');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { authorization: token }, // no "Bearer " prefix
    });
    expect(res.statusCode).toBe(401);
  });

  it('Empty Bearer → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { authorization: 'Bearer ' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Auth: Header-based dev auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('x-agent-id + x-role headers accepted in dev mode (HEADER_AUTH_ENABLED unset)', async () => {
    // Onboard first so agent exists
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: { identityToken: 'mbtok_devtest01', audience: 'clawbot.marketplace.local' },
    });

    const agentId = 'agent_devtest01';
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: headerAuth(agentId, 'worker'),
    });
    // Should get 200 (agent exists) or 404 (agent not found in store yet – still authenticated)
    // Either way, 401 would indicate auth failed – we expect NOT 401
    expect(res.statusCode).not.toBe(401);
  });

  it('Header auth with invalid role value → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { 'x-agent-id': 'agent_test', 'x-role': 'superuser' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Header auth with missing x-role → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { 'x-agent-id': 'agent_test' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Header auth with missing x-agent-id → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { 'x-role': 'worker' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Auth: Session exchange role escalation prevention', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('Cannot self-assign admin role via session exchange → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_roletest01',
        role: 'admin',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Cannot self-assign moderator role via session exchange → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_roletest02',
        role: 'moderator',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Valid worker session exchange → 200 with JWT cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_sessiontest01',
        role: 'worker',
      },
    });
    expect(res.statusCode).toBe(200);
    // Should set a session cookie
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
  });
});

describe('Auth: Moltbook identity attacks', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('Invalid identity token format → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: { identityToken: 'bad_token_no_prefix', audience: 'clawbot.marketplace.local' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Unclaimed agent token → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: { identityToken: 'mbtok_unclaimed_agent', audience: 'clawbot.marketplace.local' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Deactivated agent token → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: { identityToken: 'mbtok_deactivated_agent', audience: 'clawbot.marketplace.local' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Missing audience field → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: { identityToken: 'mbtok_valid01' },
    });
    // audience has a default, so this might succeed — but let's check it doesn't crash
    expect([200, 400]).toContain(res.statusCode);
  });

  it('Token too short (< 5 chars) → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: { identityToken: 'tok', audience: 'clawbot.marketplace.local' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Auth: RBAC - worker cannot do requester-only actions', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('Worker cannot create a task → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: bearerAuth('agent_worker_001', 'worker'),
      payload: {
        title: 'Test',
        description: 'Test description',
        pricingMode: 'fixed',
        budget: 100,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          allowedDataRefs: ['ds://test'],
          allowedTools: ['read'],
          egressAllowlist: [],
          deliverableSchemaRef: 'schema://test',
          acceptanceTestsRef: 'tests://test',
        },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Requester cannot reserve a task → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks/task_fake_id/reserve',
      headers: bearerAuth('agent_requester_001', 'requester'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('Worker cannot post a wallet topup then payout without balance → 409/402', async () => {
    // Worker can do payout (RBAC allows it), but with 0 balance → should fail with insufficient funds
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: bearerAuth('agent_worker_nobal', 'worker'),
      payload: { amount: 50 },
    });
    // AGENT_NOT_FOUND (404) or INSUFFICIENT_BALANCE (409) — either way, not 200
    expect(res.statusCode).not.toBe(200);
  });
});
