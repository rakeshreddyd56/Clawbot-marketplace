import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';

describe('session token auth', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('authenticates with bearer token from session exchange', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_session_requester',
        role: 'requester'
      }
    });

    expect(exchange.statusCode).toBe(200);
    const token = exchange.json<{ token: string }>().token;

    const me = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(me.statusCode).toBe(200);

    const agentId = me.json<{ agentId: string }>().agentId;

    const capabilities = await app.inject({
      method: 'POST',
      url: '/v1/agents/onboarding/capabilities',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        capabilities: ['orchestrator'],
        maxConcurrency: 2,
        dataClassesAllowed: ['public'],
        toolClassesAllowed: ['read', 'write']
      }
    });

    expect(capabilities.statusCode).toBe(200);

    const constitution = await app.inject({
      method: 'POST',
      url: '/v1/agents/onboarding/accept-constitution',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        constitutionVersion: 'v1'
      }
    });

    expect(constitution.statusCode).toBe(200);

    const topup = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topups',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: { amount: 55 }
    });

    expect(topup.statusCode).toBe(200);
    expect(topup.json<{ balance: number }>().balance).toBe(55);

    const profile = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(profile.statusCode).toBe(200);
    expect(profile.json<{ agentId: string }>().agentId).toBe(agentId);
  });
});
