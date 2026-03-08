import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { signWithSecret } from '@claw/utils';
import { onboardAgent } from './helpers.js';

/**
 * TASK-HARD-014: Moltbook webhook for real-time trust tier changes.
 *
 * Tests cover:
 * - Moltbook-Signature header verification on all events
 * - agent.trust_tier_changed event processing
 * - agent.suspended event → immediate sanction
 * - agent.owner_changed event → owner mismatch flag
 * - agent.unclaimed event → hard-blocked
 * - Replay protection via event ID set
 * - All events emit audit events
 * - Invalid payloads rejected
 */

const WEBHOOK_SECRET = 'test-moltbook-webhook-secret';

function signBody(body: string): string {
  return signWithSecret(body, WEBHOOK_SECRET);
}

function makeWebhookPayload(
  eventType: string,
  agentId: string,
  payload: Record<string, unknown>,
  eventId?: string
) {
  return {
    eventId: eventId ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    eventType,
    timestamp: new Date().toISOString(),
    agentId,
    payload
  };
}

async function sendWebhook(app: FastifyInstance, body: Record<string, unknown>, signature?: string) {
  const rawBody = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/moltbook',
    headers: {
      'content-type': 'application/json',
      'moltbook-signature': signature ?? signBody(rawBody)
    },
    payload: rawBody
  });
}

describe('Moltbook webhook service (TASK-HARD-014)', () => {
  let app: FastifyInstance;
  let services: AppServices;

  beforeEach(async () => {
    const built = await createApp({
      services: {
        moltbookWebhookService: undefined // Force creation with env var
      },
      rateLimit: { enabled: false }
    });
    app = built.app;
    services = built.services;

    // Override webhook secret for testing
    // We need to re-create the service with the test secret
    const { MoltbookWebhookService } = await import('../src/services/moltbook-webhook-service.js');
    (services as Record<string, unknown>).moltbookWebhookService = new MoltbookWebhookService(
      services.store,
      services.audit,
      WEBHOOK_SECRET
    );
  });

  afterEach(async () => {
    await app.close();
  });

  // ─── Signature Verification ─────────────────────────────────────────────

  describe('signature verification', () => {
    it('rejects requests with missing Moltbook-Signature header', async () => {
      const body = makeWebhookPayload('agent.trust_tier_changed', 'agent_test', {
        previousTier: 'B',
        newTier: 'A',
        karma: 150,
        posts: 40,
        comments: 30
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/moltbook',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body)
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.error.code).toBe('WEBHOOK_SIGNATURE_MISSING');
    });

    it('rejects requests with invalid signature', async () => {
      const body = makeWebhookPayload('agent.trust_tier_changed', 'agent_test', {
        previousTier: 'B',
        newTier: 'A',
        karma: 150,
        posts: 40,
        comments: 30
      });

      const res = await sendWebhook(app, body, 'invalid_signature_here');

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    it('accepts requests with valid signature', async () => {
      const body = makeWebhookPayload('agent.trust_tier_changed', 'agent_test', {
        previousTier: 'B',
        newTier: 'A',
        karma: 150,
        posts: 40,
        comments: 30
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.accepted).toBe(true);
    });
  });

  // ─── agent.trust_tier_changed ───────────────────────────────────────────

  describe('agent.trust_tier_changed', () => {
    it('updates snapshot trust tier for a known agent', async () => {
      // Onboard an agent first so they have a snapshot
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_trust',
        role: 'worker',
        capabilities: ['python']
      });

      // Verify initial tier is A (default for high karma tokens)
      const initialSnapshot = services.store.moltbookSnapshots.get(agent.agentId);
      expect(initialSnapshot).toBeDefined();
      expect(initialSnapshot!.trustTier).toBe('A');

      // Send trust tier change webhook
      const body = makeWebhookPayload('agent.trust_tier_changed', agent.agentId, {
        previousTier: 'A',
        newTier: 'B',
        karma: 30,
        posts: 8,
        comments: 5
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.action).toBe('trust_tier_updated');
      expect(json.processed).toBe(true);

      // Verify snapshot was updated
      const updatedSnapshot = services.store.moltbookSnapshots.get(agent.agentId);
      expect(updatedSnapshot!.trustTier).toBe('B');
      expect(updatedSnapshot!.agent.karma).toBe(30);
    });

    it('adds TRUST_TIER_LIMITED block reason when downgraded to C', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_downgrade',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.trust_tier_changed', agent.agentId, {
        previousTier: 'A',
        newTier: 'C',
        karma: 10,
        posts: 2,
        comments: 3
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(200);

      const snapshot = services.store.moltbookSnapshots.get(agent.agentId);
      expect(snapshot!.trustTier).toBe('C');
      expect(snapshot!.blockReasons.some((r) => r.code === 'TRUST_TIER_LIMITED')).toBe(true);
    });

    it('removes TRUST_TIER_LIMITED when upgraded from C', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_upgrade_tierc',
        role: 'worker',
        capabilities: ['python']
      });

      // First downgrade to C
      const downBody = makeWebhookPayload('agent.trust_tier_changed', agent.agentId, {
        previousTier: 'A',
        newTier: 'C',
        karma: 10,
        posts: 2,
        comments: 3
      });
      await sendWebhook(app, downBody);

      // Now upgrade to A
      const upBody = makeWebhookPayload('agent.trust_tier_changed', agent.agentId, {
        previousTier: 'C',
        newTier: 'A',
        karma: 200,
        posts: 50,
        comments: 50
      });
      const res = await sendWebhook(app, upBody);
      expect(res.statusCode).toBe(200);

      const snapshot = services.store.moltbookSnapshots.get(agent.agentId);
      expect(snapshot!.trustTier).toBe('A');
      expect(snapshot!.blockReasons.some((r) => r.code === 'TRUST_TIER_LIMITED')).toBe(false);
    });

    it('processes trust tier change for unknown agent (no snapshot)', async () => {
      const body = makeWebhookPayload('agent.trust_tier_changed', 'agent_unknown_abc', {
        previousTier: 'A',
        newTier: 'B',
        karma: 30,
        posts: 8,
        comments: 5
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.action).toBe('trust_tier_updated');

      // No snapshot should be created for unknown agents
      expect(services.store.moltbookSnapshots.has('agent_unknown_abc')).toBe(false);
    });

    it('emits audit event for trust tier change', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_audit_trust',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.trust_tier_changed', agent.agentId, {
        previousTier: 'A',
        newTier: 'B',
        karma: 30,
        posts: 8,
        comments: 5
      });

      await sendWebhook(app, body);

      const events = services.audit.getByEntity(agent.agentId);
      const trustEvent = events.find((e) => e.eventType === 'moltbook.trust_tier_changed');
      expect(trustEvent).toBeDefined();
      expect(trustEvent!.payload.previousTier).toBe('A');
      expect(trustEvent!.payload.newTier).toBe('B');
    });
  });

  // ─── agent.suspended ───────────────────────────────────────────────────

  describe('agent.suspended', () => {
    it('creates immediate sanction and suspends agent', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_suspend',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.suspended', agent.agentId, {
        reason: 'Terms of service violation',
        suspendedAt: new Date().toISOString()
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.action).toBe('agent_suspended');

      // Verify sanction was created
      const sanctions = services.store.sanctions.get(agent.agentId);
      expect(sanctions).toBeDefined();
      expect(sanctions!.length).toBeGreaterThanOrEqual(1);
      const latestSanction = sanctions!.find((s) => s.reasonCode.includes('moltbook_suspended'));
      expect(latestSanction).toBeDefined();
      expect(latestSanction!.type).toBe('SUSPEND');
      expect(latestSanction!.status).toBe('ACTIVE');

      // Verify agent status was updated
      const agentRecord = services.store.agents.get(agent.agentId);
      expect(agentRecord!.profile.status).toBe('SUSPENDED');
    });

    it('marks snapshot as hard-blocked after suspension', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_suspend_block',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.suspended', agent.agentId, {
        reason: 'Spam activity detected',
        suspendedAt: new Date().toISOString()
      });

      await sendWebhook(app, body);

      const snapshot = services.store.moltbookSnapshots.get(agent.agentId);
      expect(snapshot!.hardBlocked).toBe(true);
      expect(snapshot!.blockReasons.some((r) => r.code === 'SANCTIONED')).toBe(true);
    });

    it('emits audit event for suspension', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_audit_suspend',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.suspended', agent.agentId, {
        reason: 'Abuse report',
        suspendedAt: new Date().toISOString()
      });

      await sendWebhook(app, body);

      const events = services.audit.getByEntity(agent.agentId);
      const suspendEvent = events.find((e) => e.eventType === 'moltbook.agent_suspended');
      expect(suspendEvent).toBeDefined();
      expect(suspendEvent!.payload.reason).toBe('Abuse report');
    });
  });

  // ─── agent.owner_changed ─────────────────────────────────────────────

  describe('agent.owner_changed', () => {
    it('flags owner mismatch for moderation review', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_owner',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.owner_changed', agent.agentId, {
        previousOwnerHandle: 'old_owner_handle',
        newOwnerHandle: 'new_owner_handle'
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.action).toBe('owner_mismatch_flagged');

      // Verify owner mismatch flag was created
      const flags = Array.from(services.store.ownerMismatchFlags.values());
      const flag = flags.find((f) => f.agentId === agent.agentId);
      expect(flag).toBeDefined();
      expect(flag!.previousHandle).toBe('old_owner_handle');
      expect(flag!.newHandle).toBe('new_owner_handle');
    });

    it('adds OWNER_MISMATCH block reason to snapshot', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_owner_block',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.owner_changed', agent.agentId, {
        previousOwnerHandle: 'old_handle',
        newOwnerHandle: 'new_handle'
      });

      await sendWebhook(app, body);

      const snapshot = services.store.moltbookSnapshots.get(agent.agentId);
      expect(snapshot!.blockReasons.some((r) => r.code === 'OWNER_MISMATCH')).toBe(true);
      expect(snapshot!.agent.owner.xHandle).toBe('new_handle');
    });

    it('updates historical owner handle', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_owner_hist',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.owner_changed', agent.agentId, {
        previousOwnerHandle: 'old_hist_handle',
        newOwnerHandle: 'new_hist_handle'
      });

      await sendWebhook(app, body);

      const histHandle = services.store.historicalOwnerHandles.get(agent.agentId);
      expect(histHandle).toBe('new_hist_handle');
    });

    it('emits audit event for owner change', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_audit_owner',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.owner_changed', agent.agentId, {
        previousOwnerHandle: 'prev_handle',
        newOwnerHandle: 'next_handle'
      });

      await sendWebhook(app, body);

      const events = services.audit.getByEntity(agent.agentId);
      const ownerEvent = events.find((e) => e.eventType === 'moltbook.owner_changed');
      expect(ownerEvent).toBeDefined();
      expect(ownerEvent!.payload.previousOwnerHandle).toBe('prev_handle');
      expect(ownerEvent!.payload.newOwnerHandle).toBe('next_handle');
    });
  });

  // ─── agent.unclaimed ─────────────────────────────────────────────────

  describe('agent.unclaimed', () => {
    it('marks agent as hard-blocked', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_unc_target',
        role: 'worker',
        capabilities: ['python']
      });

      const body = makeWebhookPayload('agent.unclaimed', agent.agentId, {
        unclaimedAt: new Date().toISOString()
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.action).toBe('agent_unclaimed');

      const snapshot = services.store.moltbookSnapshots.get(agent.agentId);
      expect(snapshot!.valid).toBe(false);
      expect(snapshot!.hardBlocked).toBe(true);
      expect(snapshot!.agent.isClaimed).toBe(false);
      expect(snapshot!.blockReasons.some((r) => r.code === 'BOT_NOT_CLAIMED')).toBe(true);
    });

    it('emits audit event for unclaimed', async () => {
      const agent = await onboardAgent(app, {
        tokenSeed: 'webhook_audit_unc',
        role: 'worker',
        capabilities: ['python']
      });

      const unclaimedAt = new Date().toISOString();
      const body = makeWebhookPayload('agent.unclaimed', agent.agentId, {
        unclaimedAt
      });

      await sendWebhook(app, body);

      const events = services.audit.getByEntity(agent.agentId);
      const unclaimedEvent = events.find((e) => e.eventType === 'moltbook.agent_unclaimed');
      expect(unclaimedEvent).toBeDefined();
      expect(unclaimedEvent!.payload.unclaimedAt).toBe(unclaimedAt);
    });
  });

  // ─── Replay Protection ───────────────────────────────────────────────

  describe('replay protection', () => {
    it('detects duplicate events and returns duplicate marker', async () => {
      const eventId = 'evt_replay_test_001';
      const body = makeWebhookPayload('agent.trust_tier_changed', 'agent_replay', {
        previousTier: 'B',
        newTier: 'A',
        karma: 150,
        posts: 40,
        comments: 30
      }, eventId);

      // First call — should process
      const res1 = await sendWebhook(app, body);
      expect(res1.statusCode).toBe(200);
      const json1 = res1.json();
      expect(json1.processed).toBe(true);
      expect(json1.duplicate).toBeUndefined();

      // Second call with same eventId — should detect duplicate
      const res2 = await sendWebhook(app, body);
      expect(res2.statusCode).toBe(200);
      const json2 = res2.json();
      expect(json2.processed).toBe(false);
      expect(json2.duplicate).toBe(true);
      expect(json2.eventId).toBe(eventId);
    });

    it('emits audit event for duplicate detection', async () => {
      const eventId = 'evt_replay_audit_001';
      const body = makeWebhookPayload('agent.trust_tier_changed', 'agent_replay_audit', {
        previousTier: 'B',
        newTier: 'A',
        karma: 150,
        posts: 40,
        comments: 30
      }, eventId);

      // Process first time
      await sendWebhook(app, body);

      // Process duplicate
      await sendWebhook(app, body);

      const events = services.audit.getByEntity('agent_replay_audit');
      const dupEvent = events.find((e) => e.eventType === 'moltbook.webhook_duplicate');
      expect(dupEvent).toBeDefined();
      expect(dupEvent!.payload.duplicate).toBe(true);
    });
  });

  // ─── Invalid Payloads ────────────────────────────────────────────────

  describe('invalid payloads', () => {
    it('rejects invalid JSON body', async () => {
      const rawBody = 'not valid json {{{';
      const sig = signBody(rawBody);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/moltbook',
        headers: {
          'content-type': 'application/json',
          'moltbook-signature': sig
        },
        payload: rawBody
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects event with missing required fields', async () => {
      const body = { eventType: 'agent.trust_tier_changed' }; // missing eventId, agentId, etc.
      const rawBody = JSON.stringify(body);
      const sig = signBody(rawBody);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/moltbook',
        headers: {
          'content-type': 'application/json',
          'moltbook-signature': sig
        },
        payload: rawBody
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects trust_tier_changed with invalid payload', async () => {
      const body = makeWebhookPayload('agent.trust_tier_changed', 'agent_bad_payload', {
        // Missing required fields
        previousTier: 'A'
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(400);
    });

    it('rejects agent.suspended with invalid payload', async () => {
      const body = makeWebhookPayload('agent.suspended', 'agent_bad_suspend', {
        // Missing reason field
        suspendedAt: new Date().toISOString()
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(400);
    });

    it('rejects agent.owner_changed with invalid payload', async () => {
      const body = makeWebhookPayload('agent.owner_changed', 'agent_bad_owner', {
        // Missing newOwnerHandle
        previousOwnerHandle: 'old'
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(400);
    });

    it('rejects agent.unclaimed with invalid payload', async () => {
      const body = makeWebhookPayload('agent.unclaimed', 'agent_bad_unclaimed', {
        // Missing unclaimedAt
      });

      const res = await sendWebhook(app, body);
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Unknown Event Types ──────────────────────────────────────────────

  describe('unknown event types', () => {
    it('accepts but ignores unknown event types (forward-compatible)', async () => {
      const body = {
        eventId: 'evt_unknown_001',
        eventType: 'agent.unknown_event',
        timestamp: new Date().toISOString(),
        agentId: 'agent_unknown_type',
        payload: {}
      };

      const res = await sendWebhook(app, body);
      // Unknown event types are accepted but ignored (forward-compatible webhook handling)
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.accepted).toBe(true);
      expect(json.action).toBe('ignored');
    });
  });

  // ─── Audit Trail ─────────────────────────────────────────────────────

  describe('audit trail', () => {
    it('publishes webhook_processed audit event for successful processing', async () => {
      const body = makeWebhookPayload('agent.trust_tier_changed', 'agent_audit_main', {
        previousTier: 'B',
        newTier: 'A',
        karma: 150,
        posts: 40,
        comments: 30
      });

      await sendWebhook(app, body);

      const allEvents = services.audit.getAll();
      const webhookProcessed = allEvents.find(
        (e) => e.eventType === 'moltbook.webhook_processed'
      );
      expect(webhookProcessed).toBeDefined();
    });
  });
});
