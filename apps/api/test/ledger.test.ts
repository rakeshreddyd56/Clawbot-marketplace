/**
 * TASK-HARD-006: Ledger entry tests
 * - Verify ledger entries are created for all money movements
 * - Validate DEBIT/CREDIT entries are balanced
 * - Ensure audit trail completeness
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { authHeaders, createPostedTask, onboardAgent, topup } from './helpers.js';

describe('TASK-HARD-006: ledger operations', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('wallet ledger is empty before any operations', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'ledger_fresh_agent',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(agent.agentId, 'requester')
    });

    expect(ledger.statusCode).toBe(200);
    const body = ledger.json<{ entries: unknown[]; balance: number }>();
    expect(body.entries.length).toBe(0);
    expect(body.balance).toBe(0);
  });

  it('topup creates a CREDIT ledger entry', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'ledger_topup_credit',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, agent.agentId, 'requester', 150);

    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(agent.agentId, 'requester')
    });

    expect(ledger.statusCode).toBe(200);
    const body = ledger.json<{
      entries: Array<{ direction: string; amount: number; reason: string }>;
      balance: number;
    }>();

    expect(body.balance).toBe(150);
    expect(body.entries.length).toBe(1);
    expect(body.entries[0].direction).toBe('CREDIT');
    expect(body.entries[0].amount).toBe(150);
    expect(body.entries[0].reason).toBe('wallet.topup');
  });

  it('contract creation creates DEBIT for requester (escrow lock)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'ledger_debit_requester',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'ledger_debit_worker',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 }
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });

    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(requester.agentId, 'requester')
    });

    expect(ledger.statusCode).toBe(200);
    const body = ledger.json<{
      entries: Array<{ direction: string; amount: number; reason: string }>;
      balance: number;
    }>();

    // Should have: 1 CREDIT (topup) + 1 DEBIT (escrow lock)
    expect(body.entries.length).toBe(2);

    const credit = body.entries.find((e) => e.direction === 'CREDIT');
    const debit = body.entries.find((e) => e.direction === 'DEBIT');

    expect(credit?.amount).toBe(100);
    expect(credit?.reason).toBe('wallet.topup');
    expect(debit?.amount).toBe(100);
    expect(debit?.reason).toBe('escrow.lock');
    expect(body.balance).toBe(0);
  });

  it('milestone acceptance creates CREDIT for worker (escrow release)', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'ledger_worker_credit',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'ledger_worker_credit_w',
      role: 'worker',
      capabilities: ['python']
    });

    await topup(app, requester.agentId, 'requester', 100);

    const task = await createPostedTask(app, requester.agentId, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 }
    });

    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });
    const contract = accept.json<{ contractId: string; milestones: Array<{ milestoneId: string; amountCredits: number }> }>();

    const milestone1 = contract.milestones[0];

    // Get signature and deliver
    const sig = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: milestone1.milestoneId, content: 'content-1' }
    });
    const { signature } = sig.json<{ signature: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { milestoneId: milestone1.milestoneId, content: 'content-1', signature }
    });

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: { milestoneId: milestone1.milestoneId }
    });

    // Worker ledger should have a CREDIT for escrow release
    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(worker.agentId, 'worker')
    });

    expect(ledger.statusCode).toBe(200);
    const body = ledger.json<{
      entries: Array<{ direction: string; amount: number; reason: string }>;
      balance: number;
    }>();

    expect(body.entries.length).toBe(1);
    expect(body.entries[0].direction).toBe('CREDIT');
    expect(body.entries[0].reason).toBe('escrow.release');
    expect(body.entries[0].amount).toBe(milestone1.amountCredits);
    expect(body.balance).toBe(milestone1.amountCredits);
  });

  it('wallet balance endpoint matches ledger balance', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'ledger_balance_match',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, agent.agentId, 'requester', 300);
    await topup(app, agent.agentId, 'requester', 50);

    const balance = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(agent.agentId, 'requester')
    });

    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(agent.agentId, 'requester')
    });

    const balAmount = balance.json<{ balance: number }>().balance;
    const ledgerBalance = ledger.json<{ balance: number }>().balance;

    expect(balAmount).toBe(350);
    expect(ledgerBalance).toBe(350);
    expect(balAmount).toBe(ledgerBalance);
  });

  it('ledger shows multiple entries in chronological order', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'ledger_chrono_order',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, agent.agentId, 'requester', 100);
    await topup(app, agent.agentId, 'requester', 200);
    await topup(app, agent.agentId, 'requester', 50);

    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(agent.agentId, 'requester')
    });

    const body = ledger.json<{
      entries: Array<{ amount: number; createdAt: string }>;
      balance: number;
    }>();

    expect(body.entries.length).toBe(3);
    expect(body.balance).toBe(350);

    // Entries should be in order: 100, 200, 50
    expect(body.entries[0].amount).toBe(100);
    expect(body.entries[1].amount).toBe(200);
    expect(body.entries[2].amount).toBe(50);
  });

  it('only shows own ledger entries (not other agents)', async () => {
    const agent1 = await onboardAgent(app, {
      tokenSeed: 'ledger_isolation_1',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const agent2 = await onboardAgent(app, {
      tokenSeed: 'ledger_isolation_2',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    await topup(app, agent1.agentId, 'requester', 100);
    await topup(app, agent2.agentId, 'requester', 999);

    // agent1 should only see their own 100
    const ledger1 = await app.inject({
      method: 'GET',
      url: '/v1/wallet/ledger',
      headers: authHeaders(agent1.agentId, 'requester')
    });

    const body1 = ledger1.json<{
      entries: Array<{ amount: number }>;
      balance: number;
    }>();

    expect(body1.balance).toBe(100);
    expect(body1.entries.every((e) => e.amount !== 999)).toBe(true);
  });

  it('topup rejects negative amount', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'ledger_negative_topup',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const topupRes = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(agent.agentId, 'requester'),
      payload: { amount: -50 }
    });

    expect(topupRes.statusCode).toBe(400);
  });

  it('topup rejects zero amount', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'ledger_zero_topup',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const topupRes = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: authHeaders(agent.agentId, 'requester'),
      payload: { amount: 0 }
    });

    expect(topupRes.statusCode).toBe(400);
  });
});
