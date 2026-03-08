import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { FakeStripeAdapter } from '../src/adapters/stripe.js';

const TEST_WEBHOOK_SECRET = 'whsec_test_secret';

/**
 * Creates a valid Stripe webhook event payload.
 */
function createEventPayload(overrides: Partial<{ id: string; type: string; data: Record<string, unknown> }> = {}): string {
  const event = {
    id: overrides.id ?? `evt_${crypto.randomUUID().replace(/-/g, '')}`,
    type: overrides.type ?? 'payment_intent.succeeded',
    data: overrides.data ?? { object: { amount: 5000 } },
    created: Math.floor(Date.now() / 1000)
  };
  return JSON.stringify(event);
}

/**
 * Creates a valid Stripe signature header for a given payload.
 */
function createSignature(rawBody: string, secret = TEST_WEBHOOK_SECRET, timestamp?: number): string {
  return FakeStripeAdapter.createTestSignature(rawBody, secret, timestamp);
}

describe('Stripe webhook signature verification + idempotency (TASK-HARD-005)', () => {
  let app: FastifyInstance;
  let services: AppServices;

  beforeEach(async () => {
    const built = await createApp({
      services: {
        stripe: new FakeStripeAdapter(TEST_WEBHOOK_SECRET)
      }
    });
    app = built.app;
    services = built.services;
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Signature verification tests ─────────────────────────────────────

  describe('signature verification', () => {
    it('rejects requests with missing stripe-signature header', async () => {
      const payload = createEventPayload();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json'
        }
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('WEBHOOK_SIGNATURE_MISSING');
    });

    it('rejects requests with forged/invalid signature', async () => {
      const payload = createEventPayload();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 't=1234567890,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
        }
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    it('rejects requests with wrong webhook secret', async () => {
      const payload = createEventPayload();
      // Sign with a different secret
      const sig = createSignature(payload, 'whsec_wrong_secret');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    it('rejects requests with malformed stripe-signature header (no timestamp)', async () => {
      const payload = createEventPayload();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'v1=somesignature'
        }
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    it('rejects requests with expired timestamp (replay attack)', async () => {
      const payload = createEventPayload();
      // Create a signature with a timestamp from 10 minutes ago (exceeds 5 min tolerance)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
      const sig = createSignature(payload, TEST_WEBHOOK_SECRET, oldTimestamp);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      expect(body.error.message).toContain('timestamp too old');
    });

    it('accepts requests with valid signature', async () => {
      const payload = createEventPayload({ type: 'payment_intent.succeeded' });
      const sig = createSignature(payload);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(true);
      expect(body.action).toBe('topup_confirmed');
      expect(body.eventType).toBe('payment_intent.succeeded');
      expect(body.duplicate).toBeUndefined();
    });
  });

  // ── Event type handling tests ────────────────────────────────────────

  describe('event type handling', () => {
    it('processes charge.dispute.created events', async () => {
      const payload = createEventPayload({ type: 'charge.dispute.created' });
      const sig = createSignature(payload);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().action).toBe('hold_funds_and_raise_dispute_risk');
    });

    it('processes payout.failed events', async () => {
      const payload = createEventPayload({ type: 'payout.failed' });
      const sig = createSignature(payload);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().action).toBe('mark_payout_pending_manual_review');
    });

    it('ignores unknown event types gracefully', async () => {
      const payload = createEventPayload({ type: 'customer.created' });
      const sig = createSignature(payload);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().action).toBe('ignored');
    });
  });

  // ── Idempotency tests ────────────────────────────────────────────────

  describe('idempotency', () => {
    it('processes the first event and records its ID', async () => {
      const eventId = 'evt_idempotency_test_001';
      const payload = createEventPayload({ id: eventId, type: 'payment_intent.succeeded' });
      const sig = createSignature(payload);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(true);
      expect(body.action).toBe('topup_confirmed');
      expect(body.eventId).toBe(eventId);
      expect(body.duplicate).toBeUndefined();

      // Verify the event ID was stored
      expect(services.store.processedWebhookEventIds.has(eventId)).toBe(true);
    });

    it('returns duplicate=true for replayed event IDs', async () => {
      const eventId = 'evt_replay_test_001';
      const payload = createEventPayload({ id: eventId, type: 'payment_intent.succeeded' });
      const sig = createSignature(payload);

      // First request: should process normally
      const first = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(first.statusCode).toBe(200);
      expect(first.json().duplicate).toBeUndefined();
      expect(first.json().action).toBe('topup_confirmed');

      // Second request with same event ID: should be detected as duplicate
      const second = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(second.statusCode).toBe(200);
      const body = second.json();
      expect(body.accepted).toBe(true);
      expect(body.duplicate).toBe(true);
      expect(body.action).toBe('skipped');
      expect(body.eventId).toBe(eventId);
    });

    it('processes different event IDs independently', async () => {
      const payload1 = createEventPayload({ id: 'evt_unique_001', type: 'payment_intent.succeeded' });
      const payload2 = createEventPayload({ id: 'evt_unique_002', type: 'payout.failed' });

      const sig1 = createSignature(payload1);
      const sig2 = createSignature(payload2);

      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload1),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig1
        }
      });

      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload2),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig2
        }
      });

      expect(res1.statusCode).toBe(200);
      expect(res1.json().action).toBe('topup_confirmed');
      expect(res1.json().duplicate).toBeUndefined();

      expect(res2.statusCode).toBe(200);
      expect(res2.json().action).toBe('mark_payout_pending_manual_review');
      expect(res2.json().duplicate).toBeUndefined();

      // Both should be recorded
      expect(services.store.processedWebhookEventIds.has('evt_unique_001')).toBe(true);
      expect(services.store.processedWebhookEventIds.has('evt_unique_002')).toBe(true);
    });
  });

  // ── Audit logging tests ──────────────────────────────────────────────

  describe('audit logging', () => {
    it('publishes audit event for valid processed webhook', async () => {
      const eventId = 'evt_audit_test_001';
      const payload = createEventPayload({ id: eventId, type: 'payment_intent.succeeded' });
      const sig = createSignature(payload);

      const auditEvents: Array<{ type: string; entityId: string }> = [];
      services.audit.subscribe((event) => {
        if (event.eventType === 'payment.webhook_processed') {
          auditEvents.push({ type: event.eventType, entityId: event.entityId });
        }
      });

      await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0].entityId).toBe(eventId);
    });

    it('does NOT publish audit event for duplicate webhooks', async () => {
      const eventId = 'evt_audit_dup_001';
      const payload = createEventPayload({ id: eventId, type: 'payment_intent.succeeded' });
      const sig = createSignature(payload);

      const auditEvents: Array<{ type: string; entityId: string }> = [];
      services.audit.subscribe((event) => {
        if (event.eventType === 'payment.webhook_processed') {
          auditEvents.push({ type: event.eventType, entityId: event.entityId });
        }
      });

      // First request
      await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      // Duplicate request
      await app.inject({
        method: 'POST',
        url: '/v1/payments/stripe/webhooks',
        payload: JSON.parse(payload),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sig
        }
      });

      // Should only have 1 audit event (not 2)
      expect(auditEvents).toHaveLength(1);
    });
  });
});
