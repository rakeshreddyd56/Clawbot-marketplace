import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent } from './helpers.js';

describe('session management (exchange, reverify, logout)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('exchanges a valid moltbook identity token for a session JWT', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_exchange_worker',
        role: 'worker'
      }
    });

    expect(exchange.statusCode).toBe(200);
    const body = exchange.json<{
      token: string;
      agentId: string;
      role: string;
      trustTier: string;
      expiresAt: string;
    }>();
    expect(body.token).toBeTruthy();
    expect(body.agentId).toMatch(/^agent_/);
    expect(body.role).toBe('worker');
    expect(body.trustTier).toBe('A');
    expect(body.expiresAt).toBeTruthy();
  });

  it('rejects session exchange with hard-blocked token (expired)', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_user_expired',
        role: 'worker'
      }
    });

    expect(exchange.statusCode).toBe(403);
    expect(exchange.json<{ error: { code: string } }>().error.code).toBe('MOLTBOOK_TRUST_GATE_FAILED');
  });

  it('rejects session exchange with unclaimed token', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_user_unclaimed',
        role: 'worker'
      }
    });

    expect(exchange.statusCode).toBe(403);
    expect(exchange.json<{ error: { code: string } }>().error.code).toBe('MOLTBOOK_TRUST_GATE_FAILED');
  });

  it('rejects session exchange with invalid token format', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'bad_token_no_prefix',
        role: 'worker'
      }
    });

    // Will fail Zod validation (min(5)) or moltbook check
    expect([400, 401, 403]).toContain(exchange.statusCode);
  });

  it('defaults role to worker when not provided in exchange', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_default_role_worker'
      }
    });

    expect(exchange.statusCode).toBe(200);
    expect(exchange.json<{ role: string }>().role).toBe('worker');
  });

  it('exchanges identity token for requester role', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_exchange_requester',
        role: 'requester'
      }
    });

    expect(exchange.statusCode).toBe(200);
    expect(exchange.json<{ role: string }>().role).toBe('requester');
  });

  it('reverifies session using the last known identity token', async () => {
    // First establish an identity
    await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_reverify_agent',
        audience: 'clawbot.marketplace.local'
      }
    });

    const reverify = await app.inject({
      method: 'POST',
      url: '/v1/sessions/reverify',
      headers: authHeaders('agent_reverify_agent', 'worker'),
      payload: {}
    });

    expect(reverify.statusCode).toBe(200);
    const body = reverify.json<{
      refreshed: boolean;
      trustTier: string;
      expiresAt: string;
    }>();
    expect(body.refreshed).toBe(true);
    expect(body.trustTier).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
  });

  it('reverifies with an explicit fresh identity token', async () => {
    // Establish identity first
    await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_reverify_explicit',
        audience: 'clawbot.marketplace.local'
      }
    });

    const reverify = await app.inject({
      method: 'POST',
      url: '/v1/sessions/reverify',
      headers: authHeaders('agent_reverify_explicit', 'worker'),
      payload: {
        identityToken: 'mbtok_reverify_explicit',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(reverify.statusCode).toBe(200);
    expect(reverify.json<{ refreshed: boolean }>().refreshed).toBe(true);
  });

  it('fails reverify for agent with no prior token on record', async () => {
    const reverify = await app.inject({
      method: 'POST',
      url: '/v1/sessions/reverify',
      headers: authHeaders('agent_unknown_xyz999', 'worker'),
      payload: {}
    });

    // No snapshot found → either MOLTBOOK_STATUS_NOT_FOUND or REVERIFY_TOKEN_REQUIRED
    expect([400, 401, 404]).toContain(reverify.statusCode);
  });

  it('logs out by clearing the session cookie', async () => {
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/sessions/logout'
    });

    expect(logout.statusCode).toBe(200);
    expect(logout.json<{ ok: boolean }>().ok).toBe(true);

    // Cookie should be cleared
    const cookies = logout.cookies;
    const sessionCookie = cookies.find((c) => c.name === 'claw_session');
    if (sessionCookie) {
      // If set, maxAge should be 0 or expired
      expect(Number(sessionCookie.maxAge ?? 0)).toBeLessThanOrEqual(0);
    }
  });

  it('health endpoint returns ok without auth', async () => {
    const health = await app.inject({
      method: 'GET',
      url: '/health'
    });

    expect(health.statusCode).toBe(200);
    expect(health.json<{ status: string }>().status).toBe('ok');
  });

  it('returns moltbook identity status for verified agent', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_status_check_agent',
        audience: 'clawbot.marketplace.local'
      }
    });

    const status = await app.inject({
      method: 'GET',
      url: '/v1/identity/moltbook/status',
      headers: authHeaders('agent_status_check_agent', 'worker')
    });

    expect(status.statusCode).toBe(200);
    const body = status.json<{
      snapshot: { trustTier: string; hardBlocked: boolean };
      freshness: { expired: boolean; trustTier: string };
    }>();
    expect(body.snapshot.trustTier).toBeTruthy();
    expect(body.freshness.expired).toBe(false);
  });

  it('onboarding readiness shows all steps', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'readiness_agent',
      role: 'worker',
      capabilities: ['python']
    });

    const readiness = await app.inject({
      method: 'GET',
      url: '/v1/onboarding/readiness?role=worker',
      headers: authHeaders(agent.agentId, 'worker')
    });

    expect(readiness.statusCode).toBe(200);
    const body = readiness.json<{
      role: string;
      trustTier: string;
      items: Array<{ id: string; status: string }>;
    }>();
    expect(body.role).toBe('worker');
    expect(body.trustTier).toBeTruthy();
    expect(body.items.length).toBeGreaterThan(0);

    const identityItem = body.items.find((item) => item.id === 'identity_verified');
    expect(identityItem?.status).toBe('PASS');

    const constitutionItem = body.items.find((item) => item.id === 'constitution_accepted');
    expect(constitutionItem?.status).toBe('PASS');
  });

  it('sets a session cookie on exchange that can be used for auth', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_cookie_auth_agent',
        role: 'worker'
      }
    });

    expect(exchange.statusCode).toBe(200);
    const cookies = exchange.cookies;
    const sessionCookie = cookies.find((c) => c.name === 'claw_session');
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie?.httpOnly).toBe(true);
  });
});
