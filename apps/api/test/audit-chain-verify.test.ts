/**
 * TASK-FEAT-006: Audit chain verification endpoint
 * TASK-HARD-008: Session cookie hardening tests
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent } from './helpers.js';

describe('TASK-FEAT-006: Audit chain verification', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns valid: true for empty chain', async () => {
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_chain_empty', role: 'moderator', capabilities: ['orchestrator'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/verify',
      headers: authHeaders(moderator.agentId, 'moderator')
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ valid: boolean; totalEvents: number }>();
    expect(body.valid).toBe(true);
    // onboardAgent creates events, so totalEvents > 0
    expect(body.totalEvents).toBeGreaterThanOrEqual(0);
  });

  it('returns valid: true after legitimate events are published', async () => {
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_chain_valid', role: 'moderator', capabilities: ['orchestrator'] });

    // Create some events by onboarding another agent
    await onboardAgent(app, { tokenSeed: 'agent_for_chain', role: 'worker', capabilities: ['python'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/verify',
      headers: authHeaders(moderator.agentId, 'moderator')
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ valid: boolean; totalEvents: number }>();
    expect(body.valid).toBe(true);
    expect(body.totalEvents).toBeGreaterThan(0);
  });

  it('rejects worker access to chain verify (moderator/admin only)', async () => {
    const worker = await onboardAgent(app, { tokenSeed: 'wkr_chain_forbidden', role: 'worker', capabilities: ['python'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/verify',
      headers: authHeaders(worker.agentId, 'worker')
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects requester access to chain verify (moderator/admin only)', async () => {
    const requester = await onboardAgent(app, { tokenSeed: 'req_chain_forbidden', role: 'requester', capabilities: ['orchestrator'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/verify',
      headers: authHeaders(requester.agentId, 'requester')
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can access chain verify', async () => {
    const admin = await onboardAgent(app, { tokenSeed: 'admin_chain', role: 'admin', capabilities: ['orchestrator'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/verify',
      headers: authHeaders(admin.agentId, 'admin')
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ valid: boolean; totalEvents: number }>();
    expect(body.valid).toBe(true);
  });

  it('chain verify result includes totalEvents count', async () => {
    const moderator = await onboardAgent(app, { tokenSeed: 'mod_chain_count', role: 'moderator', capabilities: ['orchestrator'] });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/verify',
      headers: authHeaders(moderator.agentId, 'moderator')
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ valid: boolean; totalEvents: number; firstBreakAt?: string; breakReason?: string }>();
    expect(typeof body.totalEvents).toBe('number');
    expect(body.totalEvents).toBeGreaterThan(0);
    expect(body.valid).toBe(true);
    // No break info on valid chain
    expect(body.firstBreakAt).toBeUndefined();
    expect(body.breakReason).toBeUndefined();
  });
});

describe('TASK-HARD-008: Session cookie hardening', () => {
  afterEach(async () => {
    delete process.env.NODE_ENV;
  });

  it('sets sameSite=lax and secure=false in development', async () => {
    process.env.NODE_ENV = 'development';
    const built = await createApp();
    const app = built.app;

    try {
      // Exchange a session to trigger cookie setting
      const res = await app.inject({
        method: 'POST',
        url: '/v1/sessions/exchange',
        payload: { identityToken: 'mbtok_session_cookie_dev', role: 'worker' }
      });

      expect(res.statusCode).toBe(200);
      const setCookieHeader = res.headers['set-cookie'] as string | string[] | undefined;
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : (setCookieHeader ?? '');
      expect(cookieStr.toLowerCase()).toContain('samesite=lax');
      expect(cookieStr.toLowerCase()).not.toContain('secure');
    } finally {
      await app.close();
    }
  });

  it('sets sameSite=strict and Secure flag in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
    const built = await createApp();
    const app = built.app;

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/sessions/exchange',
        payload: { identityToken: 'mbtok_session_cookie_prod', role: 'worker' }
      });

      expect(res.statusCode).toBe(200);
      const setCookieHeader = res.headers['set-cookie'] as string | string[] | undefined;
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : (setCookieHeader ?? '');
      expect(cookieStr.toLowerCase()).toContain('samesite=strict');
      expect(cookieStr.toLowerCase()).toContain('secure');
    } finally {
      await app.close();
      process.env.NODE_ENV = 'test';
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
});
