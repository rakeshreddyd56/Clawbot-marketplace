/**
 * TASK-HARD-007: Header auth gate tests
 *
 * Verifies that:
 * - HEADER_AUTH_ENABLED=false → all header-auth requests return 401
 * - HEADER_AUTH_ENABLED=true → HMAC signature required and verified
 * - Expired timestamp (replay) → 401
 * - Forged x-role without valid signature → 401
 * - Session JWT auth unaffected regardless of HEADER_AUTH_ENABLED
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { onboardAgent } from './helpers.js';
import { signAuthHeaders } from '../src/core/context.js';
import { issueSessionToken } from '../src/core/session.js';

function makeHmacHeaders(agentId: string, role: string, secret: string, timestampOverride?: number): Record<string, string> {
  const timestamp = String(timestampOverride ?? Date.now());
  const payload = `${agentId}:${role}:${timestamp}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return {
    'x-agent-id': agentId,
    'x-role': role,
    'x-timestamp': timestamp,
    'x-signature': signature
  };
}

describe('TASK-HARD-007: Header auth gate', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    delete process.env.HEADER_AUTH_ENABLED;
    delete process.env.HEADER_AUTH_SECRET;
  });

  describe('HEADER_AUTH_ENABLED=false (production default)', () => {
    beforeEach(async () => {
      process.env.HEADER_AUTH_ENABLED = 'false';
      const built = await createApp();
      app = built.app;
    });

    it('rejects header-auth requests with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: {
          'x-agent-id': 'agent_fake',
          'x-role': 'worker'
        }
      });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('HEADER_AUTH_DISABLED');
    });

    it('rejects forged admin headers with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: {
          'x-agent-id': 'hacker',
          'x-role': 'admin'
        }
      });
      expect(res.statusCode).toBe(401);
    });

    it('still allows session JWT auth (Bearer token)', async () => {
      // Issue a valid session token directly
      const token = issueSessionToken({ sub: 'agent_jwt_test', role: 'worker' });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: { authorization: `Bearer ${token}` }
      });
      // JWT auth goes through — worker listing tasks without being onboarded gets 404 (not 401)
      expect(res.statusCode).not.toBe(401);
    });
  });

  describe('HEADER_AUTH_ENABLED=true (HMAC signed mode)', () => {
    const TEST_SECRET = 'test_header_auth_secret_min32bytes_x';

    beforeEach(async () => {
      process.env.HEADER_AUTH_ENABLED = 'true';
      process.env.HEADER_AUTH_SECRET = TEST_SECRET;
      const built = await createApp();
      app = built.app;
    });

    it('accepts valid HMAC-signed headers', async () => {
      // We can't complete a full request without an onboarded agent,
      // but a valid signature should pass auth and reach business logic (not 401)
      const headers = makeHmacHeaders('some_agent', 'worker', TEST_SECRET);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers
      });
      // Worker listing tasks — auth passes, result is empty list (200) or business error, not 401
      expect(res.statusCode).not.toBe(401);
    });

    it('rejects unsigned headers with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: {
          'x-agent-id': 'agent_unsigned',
          'x-role': 'worker'
          // no x-timestamp / x-signature
        }
      });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('AUTH_SIGNATURE_REQUIRED');
    });

    it('rejects forged x-role: admin without valid signature → 401', async () => {
      // Valid headers for 'worker', but manually swap x-role to 'admin'
      const ts = String(Date.now());
      const payload = `some_agent:worker:${ts}`;
      const validSig = crypto.createHmac('sha256', TEST_SECRET).update(payload).digest('hex');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: {
          'x-agent-id': 'some_agent',
          'x-role': 'admin',       // forged role
          'x-timestamp': ts,
          'x-signature': validSig  // signature was for 'worker', not 'admin'
        }
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects expired timestamp (replay attack) → 401', async () => {
      // Timestamp 60 seconds in the past
      const expiredTs = Date.now() - 60_000;
      const headers = makeHmacHeaders('some_agent', 'worker', TEST_SECRET, expiredTs);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers
      });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('AUTH_TIMESTAMP_EXPIRED');
    });

    it('rejects future timestamp (clock skew) → 401', async () => {
      // Timestamp 60 seconds in the future
      const futureTs = Date.now() + 60_000;
      const headers = makeHmacHeaders('some_agent', 'worker', TEST_SECRET, futureTs);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects wrong HMAC secret → 401', async () => {
      const headers = makeHmacHeaders('some_agent', 'worker', 'wrong_secret_here_abcdefghijklmno');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers
      });
      expect(res.statusCode).toBe(401);
    });

    it('signAuthHeaders() helper produces valid headers that pass', async () => {
      const headers = signAuthHeaders('some_agent', 'worker');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers
      });
      expect(res.statusCode).not.toBe(401);
    });

    it('session JWT auth still works independently of header auth', async () => {
      const token = issueSessionToken({ sub: 'jwt_only_agent', role: 'worker' });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: { authorization: `Bearer ${token}` }
      });
      expect(res.statusCode).not.toBe(401);
    });
  });

  describe('HEADER_AUTH_ENABLED unset (dev/test mode)', () => {
    beforeEach(async () => {
      // env var deliberately not set
      const built = await createApp();
      app = built.app;
    });

    it('allows unsigned header auth in dev mode', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: {
          'x-agent-id': 'dev_agent',
          'x-role': 'worker'
        }
      });
      // Auth passes, business logic executes — not a 401
      expect(res.statusCode).not.toBe(401);
    });
  });
});
