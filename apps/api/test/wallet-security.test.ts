/**
 * Wallet security tests
 *
 * Adversarial tests for wallet operations:
 * - Payout more than balance → INSUFFICIENT_FUNDS (409)
 * - Payout with zero balance → INSUFFICIENT_FUNDS (409)
 * - Payout of negative amount → Zod validation error (400)
 * - Payout of zero amount → Zod validation error (400)
 * - Balance reflects topup correctly
 * - Payout of exact balance succeeds with zero remainder
 * - Multiple topups accumulate correctly
 * - Ledger entries are created for topup and payout
 * - Topup/payout without auth → 401
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, onboardAgent } from './helpers.js';

// Workers cannot topup via normal route (policy restricts wallet.topup to requester/admin).
// Use admin override to seed worker balances for payout/security testing.
async function adminTopup(app: FastifyInstance, agentId: string, amount: number): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/wallet/topup',
    headers: { 'x-agent-id': agentId, 'x-role': 'admin' },
    payload: { amount }
  });
  if (res.statusCode !== 200) {
    throw new Error(`adminTopup failed: ${res.statusCode} ${res.body}`);
  }
}

describe('wallet security', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------
  // Insufficient funds attacks
  // ------------------------------------------------------------------

  it('payout more than balance returns INSUFFICIENT_FUNDS', async () => {
    // Default token → Tier A → canPayout = true
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_payout_overflow',
      role: 'worker',
      capabilities: ['python']
    });

    // Use admin override to give worker 50 credits (workers cannot topup directly)
    await adminTopup(app, worker.agentId, 50);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 200 }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('payout with zero balance returns INSUFFICIENT_FUNDS', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_payout_zero_balance',
      role: 'worker',
      capabilities: ['python']
    });

    // No topup — balance is zero
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 1 }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_FUNDS');
  });

  // ------------------------------------------------------------------
  // Invalid amount validation (Zod schema catches these before domain)
  // ------------------------------------------------------------------

  it('payout of negative amount returns 400', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_payout_neg',
      role: 'worker',
      capabilities: ['python']
    });

    // Zod rejects negative amounts before policy/domain checks
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: -50 }
    });

    expect(res.statusCode).toBe(400);
  });

  it('payout of zero amount returns 400', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_payout_zero_amt',
      role: 'worker',
      capabilities: ['python']
    });

    // Zod rejects zero (not positive) before policy/domain checks
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 0 }
    });

    expect(res.statusCode).toBe(400);
  });

  it('topup of negative amount returns 400', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_topup_neg',
      role: 'worker',
      capabilities: ['python']
    });

    // Zod rejects negative amounts before policy check even for workers
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: -100 }
    });

    expect(res.statusCode).toBe(400);
  });

  // ------------------------------------------------------------------
  // Balance consistency
  // ------------------------------------------------------------------

  it('balance reflects a single topup correctly', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_balance_single',
      role: 'worker',
      capabilities: ['python']
    });

    await adminTopup(app, worker.agentId, 150);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ balance: number }>().balance).toBe(150);
  });

  it('payout of exact balance succeeds and leaves zero balance', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_payout_exact',
      role: 'worker',
      capabilities: ['python']
    });

    await adminTopup(app, worker.agentId, 75);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 75 }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ balance: number }>().balance).toBe(0);
  });

  it('multiple topups accumulate correctly', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_multi_topup',
      role: 'worker',
      capabilities: ['python']
    });

    await adminTopup(app, worker.agentId, 100);
    await adminTopup(app, worker.agentId, 50);
    await adminTopup(app, worker.agentId, 25);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ balance: number }>().balance).toBe(175);
  });

  it('balance decreases correctly after payout', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_balance_after_payout',
      role: 'worker',
      capabilities: ['python']
    });

    await adminTopup(app, worker.agentId, 100);

    await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 30 }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ balance: number }>().balance).toBe(70);
  });

  // ------------------------------------------------------------------
  // Ledger entry consistency
  // ------------------------------------------------------------------

  it('ledger entries created for topup (CREDIT) and payout (DEBIT)', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_ledger_entries',
      role: 'worker',
      capabilities: ['python']
    });

    await adminTopup(app, worker.agentId, 100);

    await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 30 }
    });

    const ledgerRes = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(ledgerRes.statusCode).toBe(200);
    const { entries } = ledgerRes.json<{ entries: Array<{ direction: string }> }>();
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const directions = entries.map((e) => e.direction);
    expect(directions).toContain('CREDIT');
    expect(directions).toContain('DEBIT');
  });

  it('ledger balance matches wallet balance after operations', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_ledger_balance_match',
      role: 'worker',
      capabilities: ['python']
    });

    await adminTopup(app, worker.agentId, 200);
    await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 50 }
    });

    const ledgerRes = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(worker.agentId, 'worker')
    });
    const balanceRes = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(ledgerRes.statusCode).toBe(200);
    expect(balanceRes.statusCode).toBe(200);

    const { balance: ledgerBalance } = ledgerRes.json<{ balance: number }>();
    const { balance: walletBalance } = balanceRes.json<{ balance: number }>();

    expect(ledgerBalance).toBe(walletBalance);
    expect(walletBalance).toBe(150);
  });

  // ------------------------------------------------------------------
  // Auth enforcement
  // ------------------------------------------------------------------

  it('topup without any auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      payload: { amount: 100 }
    });
    expect(res.statusCode).toBe(401);
  });

  it('payout without any auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      payload: { amount: 50 }
    });
    expect(res.statusCode).toBe(401);
  });

  it('wallet balance check without auth returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance'
    });
    expect(res.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------
  // Second payout fails when balance is insufficient after first payout
  // ------------------------------------------------------------------

  it('second payout fails when first payout drained the balance', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_wrk_double_payout',
      role: 'worker',
      capabilities: ['python']
    });

    await adminTopup(app, worker.agentId, 100);

    // First payout — drains everything
    const first = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 100 }
    });
    expect(first.statusCode).toBe(200);

    // Second payout — should fail
    const second = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { amount: 1 }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_FUNDS');
  });
});
