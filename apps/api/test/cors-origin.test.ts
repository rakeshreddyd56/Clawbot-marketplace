/**
 * BUG-HIGH-001: CORS origin allowlist tests
 *
 * Verifies that CORS is restricted to an explicit allowlist instead of
 * reflecting any Origin header. `origin: true` with `credentials: true`
 * enabled CSRF on financial endpoints (topup, payout, milestone accept).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';

describe('CORS origin allowlist (BUG-HIGH-001)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  describe('default allowlist (http://localhost:3001)', () => {
    beforeEach(async () => {
      const built = await createApp();
      app = built.app;
    });

    it('allows requests from http://localhost:3001', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'http://localhost:3001',
          'access-control-request-method': 'GET'
        }
      });

      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('rejects requests from unknown origins (no ACAO header)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'https://evil-attacker.com',
          'access-control-request-method': 'GET'
        }
      });

      // No Access-Control-Allow-Origin header should be set for unknown origins
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects wildcard-like bypass attempts', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'http://localhost:3001.evil.com',
          'access-control-request-method': 'GET'
        }
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('GET request from allowed origin includes CORS headers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'http://localhost:3001'
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('GET request from disallowed origin omits CORS headers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'https://malicious-site.example'
        }
      });

      // The request still completes (server-side), but no ACAO header is set
      // so browsers would block the response from being read
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('custom allowlist via corsOrigins option', () => {
    beforeEach(async () => {
      const built = await createApp({
        corsOrigins: ['https://app.clawbot.io', 'https://console.clawbot.io']
      });
      app = built.app;
    });

    it('allows requests from first configured origin', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'https://app.clawbot.io',
          'access-control-request-method': 'GET'
        }
      });

      expect(res.headers['access-control-allow-origin']).toBe('https://app.clawbot.io');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('allows requests from second configured origin', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'https://console.clawbot.io',
          'access-control-request-method': 'GET'
        }
      });

      expect(res.headers['access-control-allow-origin']).toBe('https://console.clawbot.io');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('rejects localhost when not in custom allowlist', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'http://localhost:3001',
          'access-control-request-method': 'GET'
        }
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects attacker origin with credentials: true still set', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'https://evil.com',
          'access-control-request-method': 'POST'
        }
      });

      // Attacker origin must NOT get an ACAO header
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
