/**
 * TASK-HARD-005: Stripe webhook signature verification + idempotency tests.
 *
 * Verifies:
 * - Valid HMAC signature → event processed
 * - Forged/invalid signature → 400 WEBHOOK_SIGNATURE_INVALID
 * - Missing stripe-signature header → 400
 * - Duplicate event ID (replay) → 200 with { processed: false, duplicate: true }
 * - Timestamp outside tolerance → 400
 * - Malformed signature header → 400
 * - Different event types processed correctly after verification
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import { FakeStripeAdapter } from '../src/adapters/stripe.js';

const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_webhook_verification';

function buildSignedWebhookPayload(
  eventPayload: Record<string, unknown>,
  secret: string,
  timestampOverride?: number
): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(eventPayload);
  const signature = FakeStripeAdapter.createTestSignature(rawBody, secret, timestampOverride);
  return { rawBody, signature };
}

describe('TASK-HARD-005: Stripe webhook signature verification + idempotency', () => {
  let app: FastifyInstance;
  let services: AppServices;
  let stripeAdapter: FakeStripeAdapter;

  beforeEach(async () => {
    stripeAdapter = new FakeStripeAdapter(TEST_WEBHOOK_SECRET);
    const built = await createApp({
      services: { stripe: stripeAdapter }
    });
    app = built.app;
    services = built.services;
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid signed webhook event and processes it', async () => {
    const payload = { id: 'evt_valid_001', type: 'payment_intent.succeeded', data: { amount: 1000 } };
    const { rawBody, signature } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ accepted: boolean; action: string; processed: boolean; eventId: string }>();
    expect(body.accepted).toBe(true);
    expect(body.action).toBe('topup_confirmed');
    expect(body.processed).toBe(true);
    expect(body.eventId).toBe('evt_valid_001');
  });

  it('rejects a request with missing stripe-signature header (400)', async () => {
    const payload = { id: 'evt_no_sig', type: 'payment_intent.succeeded', data: {} };
    const rawBody = JSON.stringify(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json'
        // No stripe-signature header
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('WEBHOOK_SIGNATURE_MISSING');
  });

  it('rejects a request with a forged/wrong signature (400)', async () => {
    const payload = { id: 'evt_forged', type: 'payment_intent.succeeded', data: {} };
    const rawBody = JSON.stringify(payload);
    // Sign with a different secret
    const forgedSig = FakeStripeAdapter.createTestSignature(rawBody, 'whsec_wrong_secret_attacker');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': forgedSig
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects a request with a tampered body (signature mismatch, 400)', async () => {
    const originalPayload = { id: 'evt_tampered', type: 'payment_intent.succeeded', data: { amount: 100 } };
    const { signature } = buildSignedWebhookPayload(originalPayload, TEST_WEBHOOK_SECRET);

    // Tamper with the body after signing
    const tamperedPayload = { id: 'evt_tampered', type: 'payment_intent.succeeded', data: { amount: 999999 } };
    const tamperedBody = JSON.stringify(tamperedPayload);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: tamperedBody
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('returns duplicate marker when same event ID is replayed', async () => {
    const payload = { id: 'evt_replay_test', type: 'payout.failed', data: {} };
    const { rawBody, signature } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);

    // First request: should be processed
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    expect(res1.statusCode).toBe(200);
    const body1 = res1.json<{ processed: boolean; duplicate?: boolean }>();
    expect(body1.processed).toBe(true);
    expect(body1.duplicate).toBeUndefined();

    // Second request (replay): must return duplicate marker, not reprocess
    // Need a fresh signature because timestamp changes — but same event ID
    const { rawBody: rawBody2, signature: sig2 } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);

    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sig2
      },
      payload: rawBody2
    });

    expect(res2.statusCode).toBe(200);
    const body2 = res2.json<{ processed: boolean; duplicate: boolean; action: string }>();
    expect(body2.processed).toBe(false);
    expect(body2.duplicate).toBe(true);
    expect(body2.action).toBe('skipped');
  });

  it('rejects a signature with timestamp outside 5-minute tolerance (400)', async () => {
    const payload = { id: 'evt_stale_ts', type: 'payment_intent.succeeded', data: {} };
    // Use a timestamp 10 minutes in the past
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600;
    const { rawBody, signature } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET, staleTimestamp);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string; message: string } }>().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(res.json<{ error: { message: string } }>().error.message).toContain('tolerance');
  });

  it('rejects a malformed stripe-signature header (missing v1 field)', async () => {
    const payload = { id: 'evt_malformed_sig', type: 'payment_intent.succeeded', data: {} };
    const rawBody = JSON.stringify(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1234567890'  // missing v1= field
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('processes charge.dispute.created event correctly after verification', async () => {
    const payload = { id: 'evt_dispute_001', type: 'charge.dispute.created', data: { id: 'dp_123' } };
    const { rawBody, signature } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ action: string; processed: boolean }>();
    expect(body.action).toBe('hold_funds_and_raise_dispute_risk');
    expect(body.processed).toBe(true);
  });

  it('processes payout.failed event correctly after verification', async () => {
    const payload = { id: 'evt_payout_fail', type: 'payout.failed', data: { id: 'po_456' } };
    const { rawBody, signature } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ action: string }>().action).toBe('mark_payout_pending_manual_review');
  });

  it('publishes audit event for processed (non-duplicate) webhooks', async () => {
    const payload = { id: 'evt_audit_test', type: 'payment_intent.succeeded', data: {} };
    const { rawBody, signature } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);

    await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    // Check that an audit event was published
    const allEvents = services.audit.getAll();
    const webhookEvents = allEvents.filter(e => e.eventType === 'payment.webhook_processed');
    expect(webhookEvents.length).toBeGreaterThanOrEqual(1);
    const last = webhookEvents[webhookEvents.length - 1];
    expect(last.entityId).toBe('evt_audit_test');
  });

  it('does NOT publish audit event for duplicate webhooks', async () => {
    const payload = { id: 'evt_no_dup_audit', type: 'payment_intent.succeeded', data: {} };

    // First call
    const { rawBody: rb1, signature: sig1 } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);
    await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig1 },
      payload: rb1
    });

    const auditCountAfterFirst = services.audit.getAll().filter(e => e.eventType === 'payment.webhook_processed').length;

    // Second call (duplicate)
    const { rawBody: rb2, signature: sig2 } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);
    await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig2 },
      payload: rb2
    });

    const auditCountAfterSecond = services.audit.getAll().filter(e => e.eventType === 'payment.webhook_processed').length;
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst); // No new audit event for duplicate
  });

  it('rejects completely empty signature header', async () => {
    const payload = { id: 'evt_empty_sig', type: 'payment_intent.succeeded', data: {} };
    const rawBody = JSON.stringify(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': ''
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBHOOK_SIGNATURE_MISSING');
  });

  it('handles unknown event type gracefully (returns ignored) after signature verification', async () => {
    const payload = { id: 'evt_unknown', type: 'customer.subscription.updated', data: {} };
    const { rawBody, signature } = buildSignedWebhookPayload(payload, TEST_WEBHOOK_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ action: string }>().action).toBe('ignored');
  });
});
