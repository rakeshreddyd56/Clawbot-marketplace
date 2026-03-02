import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent } from './helpers.js';

describe('onboarding and authentication', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires capability + constitution before active operations', async () => {
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'mbtok_bootstrap_requester',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(verify.statusCode).toBe(200);
    const profile = verify.json<{ agentId: string; status: string }>();
    expect(profile.status).toBe('PENDING_CAPABILITIES');

    const topupBeforeActivation = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(profile.agentId, 'requester'),
      payload: { amount: 100 }
    });

    expect(topupBeforeActivation.statusCode).toBe(403);
    expect(topupBeforeActivation.json<{ error: { code: string } }>().error.code).toBe('AGENT_NOT_ACTIVE');

    const cap = await app.inject({
      method: 'POST',
      url: '/v1/agents/me/capabilities',
      headers: authHeaders(profile.agentId, 'requester'),
      payload: {
        capabilities: ['orchestrator'],
        maxConcurrency: 3,
        dataClassesAllowed: ['public'],
        toolClassesAllowed: ['read']
      }
    });

    expect(cap.statusCode).toBe(200);

    const constitution = await app.inject({
      method: 'POST',
      url: '/v1/agents/me/constitution/accept',
      headers: authHeaders(profile.agentId, 'requester'),
      payload: { constitutionVersion: 'v1' }
    });

    expect(constitution.statusCode).toBe(200);
    expect(constitution.json<{ status: string }>().status).toBe('ACTIVE');

    const topup = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(profile.agentId, 'requester'),
      payload: { amount: 100 }
    });

    expect(topup.statusCode).toBe(200);
    expect(topup.json<{ balance: number }>().balance).toBe(100);
  });

  it('rejects missing auth headers and invalid roles', async () => {
    const missingHeaders = await app.inject({
      method: 'GET',
      url: '/v1/agents/me'
    });

    expect(missingHeaders.statusCode).toBe(401);

    const onboarded = await onboardAgent(app, {
      tokenSeed: 'role_agent',
      role: 'worker',
      capabilities: ['python']
    });

    const invalidRole = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: {
        'x-agent-id': onboarded.agentId,
        'x-role': 'root'
      }
    });

    expect(invalidRole.statusCode).toBe(401);
    expect(invalidRole.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_ROLE');
  });
});
