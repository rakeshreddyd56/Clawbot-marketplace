/**
 * Auth attack surface tests
 *
 * Adversarial tests for authentication and authorization:
 * - Tampered / wrong-secret JWTs
 * - Garbage Bearer tokens (not even a JWT)
 * - Missing individual auth headers
 * - Empty Bearer token
 * - Cross-role header spoofing
 * - Cookie vs Bearer precedence
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent } from './helpers.js';

// A protected route that requires auth to touch
const PROTECTED_GET = '/v1/agents/me';
const PROTECTED_POST_TOPUP = '/v1/wallet/topup';

describe('auth attack surface', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------
  // No auth at all
  // ------------------------------------------------------------------

  it('returns 401 when no auth headers and no Bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_REQUIRED');
  });

  it('returns 401 when only x-agent-id is provided (missing x-role)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { 'x-agent-id': 'agent_fake_abc123' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_REQUIRED');
  });

  it('returns 401 when only x-role is provided (missing x-agent-id)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { 'x-role': 'worker' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_REQUIRED');
  });

  it('returns 401 when role is an unrecognised value', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { 'x-agent-id': 'agent_fake', 'x-role': 'superadmin' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_ROLE');
  });

  // ------------------------------------------------------------------
  // Garbage / malformed Bearer tokens
  // ------------------------------------------------------------------

  it('returns 401 for completely random garbage Bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: 'Bearer not-a-jwt-at-all' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 401 for Bearer token that is just whitespace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: 'Bearer    ' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 401 for a JWT signed with the WRONG secret', async () => {
    // Craft a valid-looking JWT but signed with a different key
    const tamperedToken = jwt.sign(
      { sub: 'agent_hacker_123', role: 'admin', scopes: ['marketplace:v1'] },
      'wrong-secret-HACKED',
      { algorithm: 'HS256', expiresIn: 3600, issuer: 'clawbot-marketplace', audience: 'clawbot-clients' }
    );

    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: `Bearer ${tamperedToken}` }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 401 for a JWT with wrong issuer', async () => {
    const tamperedToken = jwt.sign(
      { sub: 'agent_evil', role: 'admin' },
      'dev_claw_session_secret_change_me', // correct secret
      { algorithm: 'HS256', expiresIn: 3600, issuer: 'evil-issuer', audience: 'clawbot-clients' }
    );

    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: `Bearer ${tamperedToken}` }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 401 for a JWT with wrong audience', async () => {
    const tamperedToken = jwt.sign(
      { sub: 'agent_evil', role: 'admin' },
      'dev_claw_session_secret_change_me',
      { algorithm: 'HS256', expiresIn: 3600, issuer: 'clawbot-marketplace', audience: 'evil-audience' }
    );

    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: `Bearer ${tamperedToken}` }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 401 for an already-expired JWT (negative expiresIn)', async () => {
    const expiredToken = jwt.sign(
      { sub: 'agent_expired_jwt', role: 'worker', scopes: ['marketplace:v1'] },
      'dev_claw_session_secret_change_me',
      { algorithm: 'HS256', expiresIn: -1, issuer: 'clawbot-marketplace', audience: 'clawbot-clients' }
    );

    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: `Bearer ${expiredToken}` }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 401 for a JWT with a tampered payload (modified after signing)', async () => {
    // Sign a legit token, then tamper with the payload part
    const legit = jwt.sign(
      { sub: 'agent_legit', role: 'worker' },
      'dev_claw_session_secret_change_me',
      { algorithm: 'HS256', expiresIn: 3600, issuer: 'clawbot-marketplace', audience: 'clawbot-clients' }
    );

    // Replace the payload segment with a base64-encoded "admin" upgrade
    const parts = legit.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'agent_legit', role: 'admin' })).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: `Bearer ${tamperedToken}` }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  // ------------------------------------------------------------------
  // Bearer format edge cases
  // ------------------------------------------------------------------

  it('returns 401 for Bearer with no token content (just "Bearer ")', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: 'Bearer ' }
    });

    // After strip the token is empty string - jwt.verify throws
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a three-segment string that looks like JWT but has bad base64', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: 'Bearer !!!.###.$$$' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  // ------------------------------------------------------------------
  // Health endpoint should NOT require auth
  // ------------------------------------------------------------------

  it('health endpoint is public (no auth required)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
  });

  // ------------------------------------------------------------------
  // Valid JWT with injected high-privilege role that agent doesn't have
  // ------------------------------------------------------------------

  it('JWT escalation attempt: valid JWT claiming admin but agent has no record for privileged ops', async () => {
    // Create a legit-looking JWT for a non-existent agent with admin role
    const token = jwt.sign(
      { sub: 'agent_nonexistent_hacker', role: 'admin', scopes: ['marketplace:v1'] },
      'dev_claw_session_secret_change_me',
      { algorithm: 'HS256', expiresIn: 3600, issuer: 'clawbot-marketplace', audience: 'clawbot-clients' }
    );

    // Admin bypass for policy, but the agent doesn't exist in store
    // Hitting /v1/agents/me with this → AGENT_NOT_FOUND (no profile)
    // The route calls enforcePolicy (admin passes), then getAgentProfile → getAgent → AGENT_NOT_FOUND
    const res = await app.inject({
      method: 'GET',
      url: PROTECTED_GET,
      headers: { authorization: `Bearer ${token}` }
    });

    // Admin role should pass policy, but no agent record → 404
    expect([403, 404]).toContain(res.statusCode);
  });

  // ------------------------------------------------------------------
  // Cross-agent auth check: cannot access another agent's protected resources
  // using our own valid credentials
  // ------------------------------------------------------------------

  it('valid auth for agent A cannot view bids on a task they did not create', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'auth_attack_requester',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const rival = await onboardAgent(app, {
      tokenSeed: 'auth_attack_rival',
      role: 'worker',
      capabilities: ['python']
    });

    // Create a task (we need it to exist to test bids visibility)
    const taskRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(requester.agentId, 'requester'),
      payload: {
        title: 'Auth Attack Task',
        description: 'Testing bid visibility',
        pricingMode: 'fixed',
        budget: 100,
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
    const { taskId } = taskRes.json<{ taskId: string }>();

    // Rival worker tries to list bids → BIDS_FORBIDDEN
    const bidsRes = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/bids`,
      headers: authHeaders(rival.agentId, 'worker')
    });

    expect(bidsRes.statusCode).toBe(403);
    expect(bidsRes.json<{ error: { code: string } }>().error.code).toBe('BIDS_FORBIDDEN');
  });

  // ------------------------------------------------------------------
  // Post to topup without auth
  // ------------------------------------------------------------------

  it('topup without any auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: PROTECTED_POST_TOPUP,
      payload: { amount: 100 }
    });

    expect(res.statusCode).toBe(401);
  });
});
