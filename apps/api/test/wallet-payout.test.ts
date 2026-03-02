/**
 * Wallet and payout tests
 * - Wallet balance and topup
 * - Payout eligibility by trust tier
 * - Payout blocked for tier C
 * - Payout requires active agent
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent, topup } from './helpers.js';

describe('wallet and payout operations', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('worker with tier A can request payout after receiving funds', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_payout_test',
      role: 'worker',
      capabilities: ['python']
    });

    // Workers cannot topup directly (policy restriction), use admin override to fund wallet
    await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: { 'x-agent-id': worker.agentId, 'x-role': 'admin' },
      payload: { amount: 50 }
    });

    const payout = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 50 }
    });

    expect(payout.statusCode).toBe(200);
    const body = payout.json<{ status: string; payoutId: string; balance: number }>();
    expect(body.status).toBe('pending');
    expect(body.payoutId).toBeTruthy();
    expect(body.balance).toBe(0);
  });

  it('payout fails when balance is insufficient', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_insufficient_payout',
      role: 'worker',
      capabilities: ['python']
    });

    // Give worker 20 credits via admin override
    await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: { 'x-agent-id': worker.agentId, 'x-role': 'admin' },
      payload: { amount: 20 }
    });

    const payout = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 50 } // more than balance
    });

    expect(payout.statusCode).toBe(409);
    expect(payout.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('tier C worker cannot payout (blocked by eligibility, not balance)', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_tierc_nopayout_tierc',
      role: 'worker',
      capabilities: ['python']
    });

    // No topup needed - tier C block happens before balance check

    const payout = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 50 }
    });

    expect(payout.statusCode).toBe(403);
    expect(payout.json<{ error: { code: string } }>().error.code).toBe('WORKER_PAYOUT_BLOCKED');
  });

  it('payout rejects negative amount', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_neg_payout',
      role: 'worker',
      capabilities: ['python']
    });

    // No topup needed - zod/domain validation rejects before balance check
    const payout = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: -50 }
    });

    expect(payout.statusCode).toBe(400);
  });

  it('balance reflects topup correctly', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'agent_balance_check',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const balance0 = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(agent.agentId, 'requester')
    });
    expect(balance0.json<{ balance: number }>().balance).toBe(0);

    await topup(app, agent.agentId, 'requester', 200);

    const balance1 = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(agent.agentId, 'requester')
    });
    expect(balance1.json<{ balance: number }>().balance).toBe(200);
  });

  it('wallet topup via /topups alias also works', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'agent_topups_alias',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const t = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topups',
      headers: authHeaders(agent.agentId, 'requester'),
      payload: { amount: 75 }
    });
    expect(t.statusCode).toBe(200);
    expect(t.json<{ balance: number }>().balance).toBe(75);
  });

  it('payout via /payouts alias also works', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_payouts_alias',
      role: 'worker',
      capabilities: ['python']
    });

    // Use admin override to give worker balance (workers cannot topup directly)
    await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: { 'x-agent-id': worker.agentId, 'x-role': 'admin' },
      payload: { amount: 40 }
    });

    const payout = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payouts',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 40 }
    });
    expect(payout.statusCode).toBe(200);
    expect(payout.json<{ balance: number }>().balance).toBe(0);
  });

  it('inactive agent cannot topup', async () => {
    // Verify without completing onboarding (no capabilities/constitution)
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: 'mbtok_inactive_topup_agent',
        audience: 'clawbot.marketplace.local'
      }
    });
    expect(verify.statusCode).toBe(200);
    const { agentId } = verify.json<{ agentId: string }>();

    // Agent is PENDING_CAPABILITIES - not active
    const topupRes = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(agentId, 'requester'),
      payload: { amount: 100 }
    });
    expect(topupRes.statusCode).toBe(403);
    expect(topupRes.json<{ error: { code: string } }>().error.code).toBe('AGENT_NOT_ACTIVE');
  });

  it('worker eligibility shows correct trust tier and restrictions', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_eligibility_info',
      role: 'worker',
      capabilities: ['python']
    });

    const eligibility = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{
      agentId: string;
      trustTier: string;
      canBid: boolean;
      canReserve: boolean;
      canPayout: boolean;
      payoutDelayHours: number;
    }>();

    expect(body.agentId).toBe(worker.agentId);
    expect(body.trustTier).toBe('A'); // default token has high karma/posts
    expect(body.canBid).toBe(true);
    expect(body.canReserve).toBe(true);
    expect(body.canPayout).toBe(true);
    expect(body.payoutDelayHours).toBe(0);
  });

  it('tier B worker has payout delay', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'worker_tierb_payout_tierb',
      role: 'worker',
      capabilities: ['python']
    });

    const eligibility = await app.inject({
      method: 'GET',
      url: '/v1/worker/eligibility',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(eligibility.statusCode).toBe(200);
    const body = eligibility.json<{
      trustTier: string;
      payoutDelayHours: number;
    }>();

    expect(body.trustTier).toBe('B');
    expect(body.payoutDelayHours).toBe(24);
  });

  it('stripe webhook endpoint processes payment_intent.succeeded', async () => {
    const webhook = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      payload: {
        type: 'payment_intent.succeeded',
        data: { id: 'pi_test_123', amount: 1000 }
      }
    });

    expect(webhook.statusCode).toBe(200);
    const body = webhook.json<{ action: string }>();
    expect(body.action).toBe('topup_confirmed');
  });

  it('stripe webhook handles payout.failed event', async () => {
    const webhook = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      payload: {
        type: 'payout.failed',
        data: { id: 'po_test_456' }
      }
    });

    expect(webhook.statusCode).toBe(200);
    const body = webhook.json<{ action: string }>();
    expect(body.action).toBe('mark_payout_pending_manual_review');
  });

  it('stripe webhook handles charge.dispute.created event', async () => {
    const webhook = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      payload: {
        type: 'charge.dispute.created',
        data: { id: 'dp_test_789' }
      }
    });

    expect(webhook.statusCode).toBe(200);
    const body = webhook.json<{ action: string }>();
    expect(body.action).toBe('hold_funds_and_raise_dispute_risk');
  });

  it('stripe webhook handles unknown event type gracefully with ignored action', async () => {
    const webhook = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      payload: {
        type: 'customer.subscription.updated',
        data: {}
      }
    });

    // Should succeed (policy check passes) but return ignored for unknown types
    expect(webhook.statusCode).toBe(200);
    const body = webhook.json<{ action: string }>();
    expect(body.action).toBe('ignored');
  });
});
