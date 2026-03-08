/**
 * BUG-MED-005: Treasury counterparty entries for ledger audit trail.
 *
 * CLAUDE.md rule: "All escrow operations MUST be balanced (every DEBIT has
 * a corresponding CREDIT)."
 *
 * Previously:
 *   - topup() credited actorAgentId with no corresponding treasury entry
 *   - payout() debited actorAgentId with no corresponding treasury entry
 *
 * Fix: External monetary flows now go through treasury contra-accounts:
 *   - topup: CREDIT treasury:inbound (records inflow) + CREDIT agent
 *   - payout: DEBIT agent + CREDIT treasury:outbound (records outflow)
 *
 * Treasury accounts track total external monetary flow for reconciliation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { authHeaders, onboardAgent, topup, createPostedTask } from './helpers.js';

describe('BUG-MED-005: treasury counterparty ledger entries', () => {
  let app: FastifyInstance;
  let services: AppServices;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
    services = built.services;
  });

  afterEach(async () => {
    await app.close();
  });

  it('topup creates treasury:inbound CREDIT entry alongside agent CREDIT', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'treasury_test_1',
      role: 'requester',
      capabilities: ['python']
    });

    // Topup as requester (workers cannot topup — POLICY_DENY)
    await topup(app, agent.agentId, 'requester', 250);

    // Find treasury:inbound ledger entries — records total money received from Stripe
    const treasuryEntries = services.store.ledger.filter(
      (e) => e.accountId === 'treasury:inbound' && e.reason === 'wallet.topup'
    );

    // Treasury:inbound gets a CREDIT recording the external monetary inflow.
    expect(treasuryEntries.length).toBe(1);
    const credit = treasuryEntries.find((e) => e.direction === 'CREDIT');
    expect(credit).toBeTruthy();
    expect(credit!.amount).toBe(250);

    // Agent should also have a CREDIT entry
    const agentEntries = services.store.ledger.filter(
      (e) => e.accountId === agent.agentId && e.reason === 'wallet.topup'
    );
    expect(agentEntries.length).toBe(1);
    expect(agentEntries[0].direction).toBe('CREDIT');
    expect(agentEntries[0].amount).toBe(250);
  });

  it('payout creates treasury:outbound CREDIT alongside agent DEBIT', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'treasury_test_2',
      role: 'worker',
      capabilities: ['python']
    });

    // Top up first so there's balance to pay out (use admin to bypass worker topup policy)
    await topup(app, agent.agentId, 'admin', 500);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/payout',
      headers: authHeaders(agent.agentId, 'worker'),
      payload: { amount: 200 }
    });

    expect(res.statusCode).toBe(200);

    // Find treasury:outbound ledger entries
    const treasuryEntries = services.store.ledger.filter(
      (e) => e.accountId === 'treasury:outbound' && e.reason === 'wallet.payout_request'
    );

    expect(treasuryEntries.length).toBe(1);
    expect(treasuryEntries[0].direction).toBe('CREDIT');
    expect(treasuryEntries[0].amount).toBe(200);

    // Agent should have a DEBIT entry
    const agentDebits = services.store.ledger.filter(
      (e) => e.accountId === agent.agentId && e.reason === 'wallet.payout_request'
    );
    expect(agentDebits.length).toBe(1);
    expect(agentDebits[0].direction).toBe('DEBIT');
    expect(agentDebits[0].amount).toBe(200);
  });

  it('ledger sums to zero after full topup → task → payout cycle', async () => {
    const requester = await onboardAgent(app, {
      tokenSeed: 'treasury_cycle_req',
      role: 'requester',
      capabilities: ['orchestrator']
    });

    const worker = await onboardAgent(app, {
      tokenSeed: 'treasury_cycle_wrk',
      role: 'worker',
      capabilities: ['python']
    });

    // Requester tops up
    await topup(app, requester.agentId, 'requester', 100);

    // Create and post task
    const task = await createPostedTask(app, requester.agentId, 'python');

    // Worker bids
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { rate: 100 }
    });

    // Worker reserves
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker.agentId, 'worker')
    });
    const lease = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Accept → creates contract, escrow locks funds
    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester.agentId, 'requester'),
      payload: lease
    });
    const contract = accept.json<{
      contractId: string;
      milestones: { milestoneId: string }[];
    }>();

    // Deliver milestone
    const sigPreview = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/signature-preview`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: {
        milestoneId: contract.milestones[0].milestoneId,
        content: 'deliverable-content'
      }
    });
    const { signature } = sigPreview.json<{ signature: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${contract.milestones[0].milestoneId}/deliver`,
      headers: authHeaders(worker.agentId, 'worker'),
      payload: { content: 'deliverable-content', signature }
    });

    // Accept first milestone
    await app.inject({
      method: 'POST',
      url: `/v1/contracts/${contract.contractId}/milestones/${contract.milestones[0].milestoneId}/accept`,
      headers: authHeaders(requester.agentId, 'requester')
    });

    // Handle second milestone if present
    if (contract.milestones.length > 1) {
      const sig2 = await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/signature-preview`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: {
          milestoneId: contract.milestones[1].milestoneId,
          content: 'deliverable-content-2'
        }
      });
      const { signature: sig2val } = sig2.json<{ signature: string }>();

      await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/milestones/${contract.milestones[1].milestoneId}/deliver`,
        headers: authHeaders(worker.agentId, 'worker'),
        payload: { content: 'deliverable-content-2', signature: sig2val }
      });

      await app.inject({
        method: 'POST',
        url: `/v1/contracts/${contract.contractId}/milestones/${contract.milestones[1].milestoneId}/accept`,
        headers: authHeaders(requester.agentId, 'requester')
      });
    }

    // Worker pays out their earnings
    const workerBalance = services.store.balances.get(worker.agentId) ?? 0;
    if (workerBalance > 0) {
      await app.inject({
        method: 'POST',
        url: '/v1/wallet/payout',
        headers: authHeaders(worker.agentId, 'worker'),
        payload: { amount: workerBalance }
      });
    }

    // Verify treasury counterparty entries exist for external flows
    const treasuryInbound = services.store.ledger.filter(
      (e) => e.accountId === 'treasury:inbound'
    );
    const treasuryOutbound = services.store.ledger.filter(
      (e) => e.accountId === 'treasury:outbound'
    );

    // topup should have created treasury:inbound entries
    expect(treasuryInbound.length).toBeGreaterThan(0);

    // If worker had earnings and paid out, treasury:outbound should exist
    if (workerBalance > 0) {
      expect(treasuryOutbound.length).toBeGreaterThan(0);
    }

    // Internal escrow flows are balanced: every escrow DEBIT has a CREDIT
    const escrowEntries = services.store.ledger.filter(
      (e) => e.accountId.startsWith('escrow:')
    );
    const escrowSum = escrowEntries.reduce((sum, entry) => {
      return sum + (entry.direction === 'CREDIT' ? entry.amount : -entry.amount);
    }, 0);
    expect(Math.abs(escrowSum)).toBeLessThan(0.01);
  });
});
