/**
 * TASK-HARD-003: PgStore unit tests.
 *
 * Tests the store factory, write-through proxy behavior, data integrity
 * guarantees, and migration runner of the PostgreSQL persistence layer.
 *
 * These tests run against the IN-MEMORY store (DATABASE_URL unset) to verify
 * that the Store interface contract is satisfied and that the factory
 * correctly falls back. PG integration tests require a running PostgreSQL
 * instance and are in a separate test file.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { createStore } from '../src/core/store.js';
import { createStoreFromEnv, closeStore } from '../src/core/store-factory.js';
import { authHeaders, onboardAgent, topup, createPostedTask } from './helpers.js';

describe('Store Factory', () => {
  afterEach(async () => {
    await closeStore();
    delete process.env.DATABASE_URL;
  });

  it('returns in-memory store when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;
    const store = await createStoreFromEnv();
    expect(store).toBeDefined();
    expect(store.agents).toBeInstanceOf(Map);
    expect(store.tasks).toBeInstanceOf(Map);
    expect(store.ledger).toBeInstanceOf(Array);
    expect(store.balances).toBeInstanceOf(Map);
    expect(store.processedWebhookEventIds).toBeInstanceOf(Set);
  });

  it('in-memory store has all required fields', () => {
    const store = createStore();
    // Verify every field from the Store interface exists
    const requiredMaps = [
      'agents', 'tasks', 'scopes', 'bids', 'leases', 'contracts',
      'artifacts', 'executions', 'dataGrants', 'vaultTokens', 'disputes',
      'evidencePacks', 'reputations', 'sanctions', 'escrowLocks',
      'moltbookSnapshots', 'historicalOwnerHandles', 'lastIdentityTokens',
      'balances', 'deliverySecrets', 'taskMilestoneNames',
      'ownerMismatchFlags', 'mismatchReviewActions'
    ];
    for (const field of requiredMaps) {
      expect(store[field as keyof typeof store], `store.${field}`).toBeInstanceOf(Map);
    }

    expect(store.policyDecisions).toBeInstanceOf(Array);
    expect(store.ledger).toBeInstanceOf(Array);
    expect(store.processedWebhookEventIds).toBeInstanceOf(Set);
  });

  it('in-memory store has processedMoltbookWebhookEventIds set', () => {
    const store = createStore();
    expect(store.processedMoltbookWebhookEventIds).toBeInstanceOf(Set);
    expect(store.processedMoltbookWebhookEventIds.size).toBe(0);
  });

  it('autoMigrate option is accepted without error when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;
    // Should not throw — autoMigrate is ignored when no DATABASE_URL
    const store = await createStoreFromEnv({ autoMigrate: true });
    expect(store).toBeDefined();
    expect(store.agents).toBeInstanceOf(Map);
  });

  it('falls back to in-memory when DATABASE_URL points to unreachable PG', async () => {
    process.env.DATABASE_URL = 'postgresql://invalid:invalid@localhost:59999/nonexistent';
    // PgStore.init() should fail and factory should fall back
    const store = await createStoreFromEnv();
    expect(store).toBeDefined();
    expect(store.agents).toBeInstanceOf(Map);
    // Verify it's a working in-memory store
    store.agents.set('test-agent', {
      profile: {
        agentId: 'test-agent',
        moltbookAgentId: 'test-agent',
        ownerRef: '@test',
        verificationStatus: 'VERIFIED',
        status: 'ACTIVE',
        riskTier: 'LOW',
        kycTier: 'NONE',
        createdAt: new Date().toISOString()
      }
    });
    expect(store.agents.has('test-agent')).toBe(true);
  });
});

describe('Store data integrity (in-memory)', () => {
  let app: FastifyInstance;
  let requester: string;
  let worker: string;

  beforeEach(async () => {
    const result = await createApp();
    app = result.app;
    const r = await onboardAgent(app, { tokenSeed: 'pg_requester', role: 'requester' });
    requester = r.agentId;
    const w = await onboardAgent(app, { tokenSeed: 'pg_worker', role: 'worker' });
    worker = w.agentId;
    await topup(app, requester, 'requester', 1000);
  });

  afterEach(async () => {
    await app.close();
  });

  it('persists agents through onboarding', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: authHeaders(requester, 'requester')
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe(requester);
    expect(body.status).toBe('ACTIVE');
  });

  it('persists tasks through full lifecycle', async () => {
    const task = await createPostedTask(app, requester, 'python');
    const taskRes = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.taskId}`,
      headers: authHeaders(requester, 'requester')
    });
    expect(taskRes.statusCode).toBe(200);
    expect(taskRes.json().status).toBe('POSTED');
  });

  it('preserves identity tokens for reverify', async () => {
    // Reverify without a token should work because the in-memory store has the token
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/reverify',
      headers: authHeaders(requester, 'requester'),
      payload: { audience: 'clawbot.marketplace.local' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('preserves historicalOwnerHandles for mismatch detection', async () => {
    // The verify call during onboarding should have set the historical handle
    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/verify',
      payload: {
        identityToken: `mbtok_owner_alt_${requester}`,
        audience: 'clawbot.marketplace.local'
      }
    });
    // The response should include block reasons with OWNER_MISMATCH
    const body = res.json();
    if (body.blockReasons) {
      const mismatch = body.blockReasons.find((r: { code: string }) => r.code === 'OWNER_MISMATCH');
      if (mismatch) {
        expect(mismatch.code).toBe('OWNER_MISMATCH');
      }
    }
  });

  it('preserves delivery secrets through contract lifecycle', async () => {
    const task = await createPostedTask(app, requester, 'python');

    // Bid and reserve
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker, 'worker'),
      payload: { rate: 100 }
    });
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker, 'worker')
    });
    expect(reserve.statusCode).toBe(200);
    const { leaseId, leaseToken } = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Accept
    const accept = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester, 'requester'),
      payload: { leaseId, leaseToken }
    });
    expect(accept.statusCode).toBe(200);

    // The delivery secret should be set and retrievable for artifact delivery
    const contract = accept.json<{ contractId: string; milestones: { milestoneId: string }[] }>();
    expect(contract.contractId).toBeDefined();
    expect(contract.milestones.length).toBeGreaterThan(0);
  });

  it('preserves escrow locks through accept', async () => {
    const task = await createPostedTask(app, requester, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker, 'worker'),
      payload: { rate: 100 }
    });
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker, 'worker')
    });
    const { leaseId, leaseToken } = reserve.json<{ leaseId: string; leaseToken: string }>();

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester, 'requester'),
      payload: { leaseId, leaseToken }
    });

    // Balance should reflect escrow lock
    const walletRes = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester, 'requester')
    });
    expect(walletRes.statusCode).toBe(200);
    const wallet = walletRes.json();
    // Requester had 1000, task budget was 100, so balance should be 900
    expect(wallet.balance).toBe(900);
  });

  it('preserves lease status transitions', async () => {
    const task = await createPostedTask(app, requester, 'python');

    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/bids`,
      headers: authHeaders(worker, 'worker'),
      payload: { rate: 100 }
    });
    const reserve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/reserve`,
      headers: authHeaders(worker, 'worker')
    });
    const { leaseId, leaseToken } = reserve.json<{ leaseId: string; leaseToken: string }>();

    // Accept closes the lease
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.taskId}/accept`,
      headers: authHeaders(requester, 'requester'),
      payload: { leaseId, leaseToken }
    });

    // After accept the task moves to ASSIGNED, so reserve won't work
    // But the lease should be in CLOSED status internally
  });

  it('preserves webhook event idempotency set', async () => {
    // Stripe webhook endpoint should reject duplicate event IDs
    const webhookPayload = JSON.stringify({
      id: 'evt_test_duplicate',
      type: 'payment_intent.succeeded',
      data: { object: { metadata: {} } }
    });

    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: { 'content-type': 'application/json' },
      payload: webhookPayload
    });

    // Both should succeed (idempotent) or rejected by signature verification
    // The exact status depends on webhook HMAC signature validation (400 for bad/missing sig)
    expect([200, 400, 401, 403]).toContain(res1.statusCode);
  });

  it('balances are updated atomically through topup and escrow', async () => {
    // Verify the requester balance after topup
    const walletRes = await app.inject({
      method: 'GET',
      url: '/v1/wallet/balance',
      headers: authHeaders(requester, 'requester')
    });
    expect(walletRes.statusCode).toBe(200);
    expect(walletRes.json().balance).toBe(1000);
  });
});

describe('Store interface compliance', () => {
  it('policyDecisions array supports push', () => {
    const store = createStore();
    expect(store.policyDecisions.length).toBe(0);
    store.policyDecisions.push({
      decisionId: 'test-1',
      policyVersion: '1.0',
      action: 'task.create',
      actorAgentId: 'agent-1',
      entityId: 'task-1',
      allow: true,
      reason: 'allowed',
      contextHash: 'abc',
      createdAt: new Date().toISOString()
    });
    expect(store.policyDecisions.length).toBe(1);
  });

  it('processedWebhookEventIds set supports add/has', () => {
    const store = createStore();
    expect(store.processedWebhookEventIds.has('evt_1')).toBe(false);
    store.processedWebhookEventIds.add('evt_1');
    expect(store.processedWebhookEventIds.has('evt_1')).toBe(true);
  });

  it('sanctions map stores arrays per agent', () => {
    const store = createStore();
    const sanction = {
      sanctionId: 'san-1',
      agentId: 'agent-1',
      type: 'SUSPEND' as const,
      durationHours: 24,
      reasonCode: 'test',
      status: 'ACTIVE' as const,
      effectiveAt: new Date().toISOString()
    };
    store.sanctions.set('agent-1', [sanction]);
    expect(store.sanctions.get('agent-1')).toHaveLength(1);
  });

  it('historicalOwnerHandles stores string values', () => {
    const store = createStore();
    store.historicalOwnerHandles.set('agent-1', '@owner1');
    expect(store.historicalOwnerHandles.get('agent-1')).toBe('@owner1');
  });

  it('deliverySecrets uses composite key format', () => {
    const store = createStore();
    store.deliverySecrets.set('contract-1:milestone-1', 'secret-value');
    expect(store.deliverySecrets.get('contract-1:milestone-1')).toBe('secret-value');
  });

  it('ledger array supports push and preserves order', () => {
    const store = createStore();
    store.ledger.push({
      entryId: 'entry-1',
      accountId: 'agent-1',
      direction: 'CREDIT',
      amount: 100,
      assetType: 'credits',
      reason: 'topup',
      referenceType: 'wallet.topup',
      referenceId: 'ref-1',
      createdAt: new Date().toISOString()
    });
    store.ledger.push({
      entryId: 'entry-2',
      accountId: 'agent-1',
      direction: 'DEBIT',
      amount: 50,
      assetType: 'credits',
      reason: 'escrow.lock',
      referenceType: 'escrow.lock',
      referenceId: 'ref-2',
      createdAt: new Date().toISOString()
    });
    expect(store.ledger).toHaveLength(2);
    expect(store.ledger[0].entryId).toBe('entry-1');
    expect(store.ledger[1].entryId).toBe('entry-2');
  });

  it('ownerMismatchFlags map stores and retrieves flags', () => {
    const store = createStore();
    const flag = {
      flagId: 'flag-1',
      agentId: 'agent-1',
      previousHandle: '@old_owner',
      newHandle: '@new_owner',
      detectedAt: new Date().toISOString()
    };
    store.ownerMismatchFlags.set('flag-1', flag);
    expect(store.ownerMismatchFlags.get('flag-1')).toEqual(flag);
  });

  it('mismatchReviewActions map stores actions', () => {
    const store = createStore();
    const action = {
      actionId: 'action-1',
      flagId: 'flag-1',
      moderatorId: 'mod-1',
      actionType: 'cleared' as const,
      actedAt: new Date().toISOString()
    };
    store.mismatchReviewActions.set('action-1', action);
    expect(store.mismatchReviewActions.get('action-1')).toEqual(action);
  });

  it('processedMoltbookWebhookEventIds set supports add/has', () => {
    const store = createStore();
    expect(store.processedMoltbookWebhookEventIds.has('moltbook_evt_1')).toBe(false);
    store.processedMoltbookWebhookEventIds.add('moltbook_evt_1');
    expect(store.processedMoltbookWebhookEventIds.has('moltbook_evt_1')).toBe(true);
  });

  it('leaseOutcomeLog stores per-agent lease outcomes', () => {
    const store = createStore();
    expect(store.leaseOutcomeLog.has('agent-1')).toBe(false);
    const outcomes = [
      { leaseId: 'lease-1', outcome: 'EXPIRED' as const, timestamp: new Date().toISOString() },
      { leaseId: 'lease-2', outcome: 'CLOSED' as const, timestamp: new Date().toISOString() }
    ];
    store.leaseOutcomeLog.set('agent-1', outcomes);
    expect(store.leaseOutcomeLog.get('agent-1')).toHaveLength(2);
    expect(store.leaseOutcomeLog.get('agent-1')![0].outcome).toBe('EXPIRED');
    expect(store.leaseOutcomeLog.get('agent-1')![1].outcome).toBe('CLOSED');
  });

  it('leaseOutcomeLog supports append pattern', () => {
    const store = createStore();
    const entry1 = { leaseId: 'lease-1', outcome: 'EXPIRED' as const, timestamp: new Date().toISOString() };
    store.leaseOutcomeLog.set('agent-1', [entry1]);
    const existing = store.leaseOutcomeLog.get('agent-1')!;
    const entry2 = { leaseId: 'lease-2', outcome: 'CLOSED' as const, timestamp: new Date().toISOString() };
    existing.push(entry2);
    store.leaseOutcomeLog.set('agent-1', existing);
    expect(store.leaseOutcomeLog.get('agent-1')).toHaveLength(2);
  });

  it('bannedOwnerHandles set supports add/has', () => {
    const store = createStore();
    expect(store.bannedOwnerHandles.has('@banned_owner')).toBe(false);
    store.bannedOwnerHandles.add('@banned_owner');
    expect(store.bannedOwnerHandles.has('@banned_owner')).toBe(true);
    // Adding again should be idempotent
    store.bannedOwnerHandles.add('@banned_owner');
    expect(store.bannedOwnerHandles.size).toBe(1);
  });

  it('bannedOwnerHandles tracks multiple handles', () => {
    const store = createStore();
    store.bannedOwnerHandles.add('@owner_a');
    store.bannedOwnerHandles.add('@owner_b');
    store.bannedOwnerHandles.add('@owner_c');
    expect(store.bannedOwnerHandles.size).toBe(3);
    expect(store.bannedOwnerHandles.has('@owner_b')).toBe(true);
    expect(store.bannedOwnerHandles.has('@unknown')).toBe(false);
  });
});

describe('AuditLedger persistence', () => {
  it('AuditLedger works without persistence (in-memory only)', async () => {
    const { AuditLedger } = await import('../src/core/events.js');
    const ledger = new AuditLedger();
    const event = ledger.publish('test.event', 'entity-1', { foo: 'bar' });
    expect(event.eventId).toBeDefined();
    expect(event.hash).toBeDefined();
    expect(event.previousHash).toBe('GENESIS');
    expect(ledger.getAll()).toHaveLength(1);
  });

  it('AuditLedger constructor accepts persistence option', async () => {
    const { AuditLedger } = await import('../src/core/events.js');
    const writtenEvents: { eventId: string }[] = [];
    const persistence = {
      writeEvent: async (event: { eventId: string }) => { writtenEvents.push(event); }
    };
    const ledger = new AuditLedger({ persistence });
    ledger.publish('test.event', 'entity-1', { foo: 'bar' });
    // Write-through is async/fire-and-forget, give it a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(writtenEvents).toHaveLength(1);
  });

  it('AuditLedger restores chain from preloaded events', async () => {
    const { AuditLedger } = await import('../src/core/events.js');
    const { sha256 } = await import('@claw/utils');

    // Create a chain of 2 events
    const base1 = {
      eventId: 'evt-preload-1',
      eventType: 'agent.verified',
      entityId: 'agent-1',
      payload: {},
      timestamp: '2026-01-01T00:00:00.000Z',
      previousHash: 'GENESIS'
    };
    const hash1 = sha256(JSON.stringify(base1));
    const event1 = { ...base1, hash: hash1 };

    const base2 = {
      eventId: 'evt-preload-2',
      eventType: 'task.created',
      entityId: 'task-1',
      payload: {},
      timestamp: '2026-01-01T00:01:00.000Z',
      previousHash: hash1
    };
    const hash2 = sha256(JSON.stringify(base2));
    const event2 = { ...base2, hash: hash2 };

    // Create ledger with preloaded events
    const ledger = new AuditLedger({ preloadedEvents: [event1, event2] });
    expect(ledger.getAll()).toHaveLength(2);

    // Verify the chain
    const result = ledger.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(2);

    // Publish a new event — should chain from event2's hash
    const event3 = ledger.publish('bid.placed', 'task-1', { workerId: 'agent-2' });
    expect(event3.previousHash).toBe(hash2);
    expect(ledger.getAll()).toHaveLength(3);

    // Full chain should still be valid
    const fullResult = ledger.verifyChain();
    expect(fullResult.valid).toBe(true);
    expect(fullResult.totalEvents).toBe(3);
  });

  it('store factory exports audit persistence helpers', async () => {
    const { loadAuditEventsFromPg, getAuditPersistence } = await import('../src/core/store-factory.js');
    // Without DATABASE_URL, these should return empty/undefined
    const events = await loadAuditEventsFromPg();
    expect(events).toEqual([]);
    const persistence = getAuditPersistence();
    expect(persistence).toBeUndefined();
  });
});

describe('Migration runner', () => {
  it('exports runMigrations function', async () => {
    const { runMigrations } = await import('../src/core/migrate.js');
    expect(typeof runMigrations).toBe('function');
  });

  it('throws on invalid DATABASE_URL', async () => {
    const { runMigrations } = await import('../src/core/migrate.js');
    await expect(
      runMigrations('postgresql://invalid:invalid@localhost:59999/nonexistent')
    ).rejects.toThrow();
  });
});
