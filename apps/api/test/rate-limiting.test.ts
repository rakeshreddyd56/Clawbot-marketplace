/**
 * TASK-HARD-009: Rate limiting tests
 *
 * Verifies:
 * - Global rate limit (100 req/min per IP by default)
 * - Payout route stricter limit (10 req/min per agent)
 * - Moltbook verify route stricter limit (5 req/min per IP)
 * - 429 response with Retry-After header and RATE_LIMITED code
 * - Rate limiting can be disabled via options
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { authHeaders, onboardAgent, topup } from './helpers.js';

describe('Rate limiting (TASK-HARD-009)', () => {
  let app: FastifyInstance;
  let services: AppServices;

  afterEach(async () => {
    await app.close();
  });

  describe('global rate limit', () => {
    beforeEach(async () => {
      const built = await createApp({
        rateLimit: {
          enabled: true,
          globalMax: 3,
          timeWindow: 60_000
        }
      });
      app = built.app;
      services = built.services;
    });

    it('allows requests within the global limit', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
      }
    });

    it('returns 429 when global limit is exceeded', async () => {
      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'GET', url: '/health' });
      }

      // Next request should be rate limited
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.retryAfter).toBeDefined();
    });

    it('includes retry-after header in 429 response', async () => {
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'GET', url: '/health' });
      }

      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('includes x-ratelimit headers in normal responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });
  });

  describe('payout route stricter limit', () => {
    beforeEach(async () => {
      const built = await createApp({
        rateLimit: {
          enabled: true,
          globalMax: 1000,  // High global so it doesn't interfere
          payoutMax: 2,
          timeWindow: 60_000
        }
      });
      app = built.app;
      services = built.services;
    });

    it('allows payout requests within the payout limit', async () => {
      const { agentId: requesterId } = await onboardAgent(app, { tokenSeed: 'requester_rl', role: 'requester' });
      await topup(app, requesterId, 'requester', 5000);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/wallet/payout',
        headers: authHeaders(requesterId, 'requester'),
        payload: { amount: 10 }
      });

      // First request should succeed (or fail for business reasons, not rate limit)
      expect(res.statusCode).not.toBe(429);
    });

    it('returns 429 when payout limit is exceeded', async () => {
      const { agentId: requesterId } = await onboardAgent(app, { tokenSeed: 'requester_rl2', role: 'requester' });
      await topup(app, requesterId, 'requester', 5000);

      // Exhaust the payout limit
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/wallet/payout',
          headers: authHeaders(requesterId, 'requester'),
          payload: { amount: 10 }
        });
      }

      // Third payout should be rate limited
      const res = await app.inject({
        method: 'POST',
        url: '/v1/wallet/payout',
        headers: authHeaders(requesterId, 'requester'),
        payload: { amount: 10 }
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('RATE_LIMITED');
    });

    it('rate limits /v1/wallet/payouts alias equally', async () => {
      const { agentId: requesterId } = await onboardAgent(app, { tokenSeed: 'requester_rl3', role: 'requester' });
      await topup(app, requesterId, 'requester', 5000);

      // Exhaust limit via /v1/wallet/payouts
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/wallet/payouts',
          headers: authHeaders(requesterId, 'requester'),
          payload: { amount: 10 }
        });
      }

      const res = await app.inject({
        method: 'POST',
        url: '/v1/wallet/payouts',
        headers: authHeaders(requesterId, 'requester'),
        payload: { amount: 10 }
      });
      expect(res.statusCode).toBe(429);
    });
  });

  describe('Moltbook verify route stricter limit', () => {
    beforeEach(async () => {
      const built = await createApp({
        rateLimit: {
          enabled: true,
          globalMax: 1000,
          moltbookVerifyMax: 2,
          timeWindow: 60_000
        }
      });
      app = built.app;
      services = built.services;
    });

    it('allows verify requests within the Moltbook limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/identity/moltbook/verify',
        payload: { identityToken: 'mbtok_testrl1', audience: 'clawbot.marketplace.local' }
      });

      expect(res.statusCode).not.toBe(429);
    });

    it('returns 429 when Moltbook verify limit is exceeded', async () => {
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/identity/moltbook/verify',
          payload: { identityToken: `mbtok_testrl${i}`, audience: 'clawbot.marketplace.local' }
        });
      }

      const res = await app.inject({
        method: 'POST',
        url: '/v1/identity/moltbook/verify',
        payload: { identityToken: 'mbtok_testrl_extra', audience: 'clawbot.marketplace.local' }
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('RATE_LIMITED');
    });

    it('rate limits /v1/onboarding/verify equally', async () => {
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/onboarding/verify',
          payload: { identityToken: `mbtok_testob${i}`, audience: 'clawbot.marketplace.local' }
        });
      }

      const res = await app.inject({
        method: 'POST',
        url: '/v1/onboarding/verify',
        payload: { identityToken: 'mbtok_testob_extra', audience: 'clawbot.marketplace.local' }
      });
      expect(res.statusCode).toBe(429);
    });

    it('rate limits /v1/sessions/exchange equally', async () => {
      // Sessions exchange also calls moltbook verify, so it should share the limit
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/sessions/exchange',
          payload: { identityToken: `mbtok_testse${i}`, role: 'worker' }
        });
      }

      const res = await app.inject({
        method: 'POST',
        url: '/v1/sessions/exchange',
        payload: { identityToken: 'mbtok_testse_extra', role: 'worker' }
      });
      expect(res.statusCode).toBe(429);
    });
  });

  describe('rate limiting disabled', () => {
    beforeEach(async () => {
      const built = await createApp({
        rateLimit: { enabled: false }
      });
      app = built.app;
      services = built.services;
    });

    it('allows unlimited requests when rate limiting is disabled', async () => {
      // Send many requests — none should be rate limited
      for (let i = 0; i < 20; i++) {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
      }
    });

    it('does not include rate limit headers when disabled', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });
  });
});
