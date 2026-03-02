import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent } from './helpers.js';

describe('moltbook trust gate and eligibility', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('hard-blocks onboarding when claimed or owner verification checks fail', async () => {
    const unclaimed = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'mbtok_worker_unclaimed',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(unclaimed.statusCode).toBe(403);
    expect(unclaimed.json<{ error: { code: string } }>().error.code).toBe('MOLTBOOK_TRUST_GATE_FAILED');

    const ownerUnverified = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_worker_owner_unverified',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(ownerUnverified.statusCode).toBe(200);
    const ownerPayload = ownerUnverified.json<{ activationAllowed: boolean; snapshot: { hardBlocked: boolean } }>();
    expect(ownerPayload.activationAllowed).toBe(false);
    expect(ownerPayload.snapshot.hardBlocked).toBe(true);
  });

  it('treats expired Moltbook tokens as blocking for session exchange', async () => {
    const expired = await app.inject({
      method: 'POST',
      url: '/v1/identity/moltbook/verify',
      payload: {
        identityToken: 'mbtok_worker_expired',
        audience: 'clawbot.marketplace.local'
      }
    });

    expect(expired.statusCode).toBe(200);
    const payload = expired.json<{ activationAllowed: boolean; snapshot: { blockReasons: Array<{ code: string }> } }>();
    expect(payload.activationAllowed).toBe(false);
    expect(payload.snapshot.blockReasons.some((item) => item.code === 'TOKEN_EXPIRED')).toBe(true);

    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/sessions/exchange',
      payload: {
        identityToken: 'mbtok_worker_expired',
        role: 'worker'
      }
    });

    expect(exchange.statusCode).toBe(403);
    expect(exchange.json<{ error: { code: string } }>().error.code).toBe('MOLTBOOK_TRUST_GATE_FAILED');
  });

  it('allows tier C onboarding and bids but blocks reserve and payout', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'tierc_requester',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'tierc_worker_tierc',
      role: 'worker',
      capabilities: ['python']
    });

    const task = await createPostedTask(app, requester.agentId, 'python');

    const bid = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 40 }
    });

    expect(bid.statusCode).toBe(200);

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(reserve.statusCode).toBe(403);
    expect(reserve.json<{ error: { code: string } }>().error.code).toBe('WORKER_RESERVE_BLOCKED');

    const eligibility = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const workerEligibility = eligibility.json<{ trustTier: string; canBid: boolean; canReserve: boolean; canPayout: boolean }>();
    expect(workerEligibility.trustTier).toBe('C');
    expect(workerEligibility.canBid).toBe(true);
    expect(workerEligibility.canReserve).toBe(false);
    expect(workerEligibility.canPayout).toBe(false);
  });
});
