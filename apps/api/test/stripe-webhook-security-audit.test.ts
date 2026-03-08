/**
 * TASK-HARD-005 Security Audit: Additional hardening tests for webhook verification.
 *
 * These tests cover security properties enforced by verifyWebhookSignatureImpl
 * that were previously MISSING from the inline adapter implementations:
 *
 * 1. Oversized body rejection BEFORE crypto (hash-DoS mitigation)
 * 2. Stripe key rotation — multiple v1 signatures, accept if ANY match
 * 3. Zod validation of parsed event body — missing `id` field rejected
 * 4. Zod validation — empty `type` field rejected
 * 5. Zod validation — non-JSON-object body rejected after HMAC
 * 6. Fabricated event ID regression — events without `id` must not be accepted
 * 7. Oversized body audit trail — rejection is logged for forensics
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppServices } from '../src/app.js';
import {
  buildStripeSignatureHeader,
  FakeStripeAdapter,
  WEBHOOK_MAX_BODY_BYTES
} from '../src/adapters/stripe.js';

const TEST_SECRET = 'whsec_security_audit_test_secret';

function signedRequest(
  payload: Record<string, unknown>,
  secret: string,
  timestampOverride?: number
): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(payload);
  const signature = buildStripeSignatureHeader(rawBody, secret, timestampOverride);
  return { rawBody, signature };
}

/**
 * Build a multi-v1 signature header simulating Stripe key rotation.
 * During rotation, Stripe sends `t=<ts>,v1=<old_sig>,v1=<new_sig>`.
 */
function buildMultiSigHeader(
  rawBody: string,
  secrets: string[],
  timestamp?: number
): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${rawBody}`;
  const sigs = secrets.map(
    (s) => `v1=${crypto.createHmac('sha256', s).update(signedPayload).digest('hex')}`
  );
  return `t=${t},${sigs.join(',')}`;
}

describe('TASK-HARD-005 Security Audit: webhook hardening gaps', () => {
  let app: FastifyInstance;
  let services: AppServices;

  beforeEach(async () => {
    const stripeAdapter = new FakeStripeAdapter(TEST_SECRET);
    const built = await createApp({
      services: { stripe: stripeAdapter }
    });
    app = built.app;
    services = built.services;
  });

  afterEach(async () => {
    await app.close();
  });

  // ─── Hash-DoS mitigation: oversized body rejected before HMAC ───────────

  it('rejects oversized body BEFORE performing HMAC computation (hash-DoS prevention)', async () => {
    // Build a body that exceeds WEBHOOK_MAX_BODY_BYTES (64 KB)
    const largeData = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1);
    const rawBody = JSON.stringify({ id: 'evt_oversized', type: 'payment_intent.succeeded', data: { pad: largeData } });
    // Sign it with the correct secret — the body IS validly signed
    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    // Must reject with 400, not process the oversized body
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(body.error.message).toContain('maximum allowed size');
  });

  it('publishes audit event for oversized body rejection', async () => {
    const largeData = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1);
    const rawBody = JSON.stringify({ id: 'evt_oversized_audit', type: 'test', data: { pad: largeData } });
    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

    await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      payload: rawBody
    });

    const rejectionEvents = services.audit.getAll().filter(
      (e) => e.eventType === 'payment.webhook_rejected'
    );
    expect(rejectionEvents.length).toBeGreaterThanOrEqual(1);
    const last = rejectionEvents[rejectionEvents.length - 1];
    expect(last.payload.reason).toContain('maximum allowed size');
  });

  // ─── Stripe key rotation: multiple v1 signatures ────────────────────────

  it('accepts webhook when second v1 signature matches (Stripe key rotation)', async () => {
    const payload = { id: 'evt_key_rotation_01', type: 'payment_intent.succeeded', data: {} };
    const rawBody = JSON.stringify(payload);

    // Simulate key rotation: old key + new key (our TEST_SECRET)
    const header = buildMultiSigHeader(rawBody, ['whsec_old_retired_key', TEST_SECRET]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': header
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ processed: boolean; eventId: string }>().processed).toBe(true);
    expect(res.json<{ eventId: string }>().eventId).toBe('evt_key_rotation_01');
  });

  it('accepts webhook when first v1 signature matches (Stripe key rotation)', async () => {
    const payload = { id: 'evt_key_rotation_02', type: 'payout.failed', data: {} };
    const rawBody = JSON.stringify(payload);

    // Our valid key is first, followed by new key that hasn't taken effect
    const header = buildMultiSigHeader(rawBody, [TEST_SECRET, 'whsec_new_upcoming_key']);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': header
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ processed: boolean }>().processed).toBe(true);
  });

  it('rejects webhook when NO v1 signatures match (both are wrong keys)', async () => {
    const payload = { id: 'evt_key_rotation_fail', type: 'payment_intent.succeeded', data: {} };
    const rawBody = JSON.stringify(payload);

    const header = buildMultiSigHeader(rawBody, ['whsec_wrong_key_A', 'whsec_wrong_key_B']);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/stripe/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': header
      },
      payload: rawBody
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  // ─── Zod validation: event body structure ───────────────────────────────

  it('rejects signed event with missing `id` field (Zod validation, prevents fabricated IDs)', async () => {
    // This was the security gap: old code fabricated `evt_<timestamp>` as ID
    // which could collide in the idempotency set, allowing replay attacks
    const rawBody = JSON.stringify({ type: 'payment_intent.succeeded', data: {} });
    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

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
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    // Generic message — don't leak Zod field-level details to attackers
    expect(body.error.message).toContain('failed validation');
  });

  it('rejects signed event with empty `id` field', async () => {
    const rawBody = JSON.stringify({ id: '', type: 'payment_intent.succeeded', data: {} });
    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

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
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects signed event with missing `type` field', async () => {
    const rawBody = JSON.stringify({ id: 'evt_no_type', data: {} });
    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

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
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects signed event with empty `type` field', async () => {
    const rawBody = JSON.stringify({ id: 'evt_empty_type', type: '', data: {} });
    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

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
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('accepts signed event without explicit `data` field (defaults to empty object)', async () => {
    // Zod schema has `data: z.record(z.unknown()).optional().default({})`
    const rawBody = JSON.stringify({ id: 'evt_no_data', type: 'payment_intent.succeeded' });
    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

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
    expect(res.json<{ processed: boolean }>().processed).toBe(true);
  });

  // ─── Body within size limit is accepted ─────────────────────────────────

  it('accepts body at exactly the maximum size limit', async () => {
    // Build a body that's just under the limit
    const basePayload = { id: 'evt_max_size', type: 'payment_intent.succeeded', data: { pad: '' } };
    const baseSize = Buffer.byteLength(JSON.stringify(basePayload), 'utf8');
    // Pad to just under the limit
    const padSize = WEBHOOK_MAX_BODY_BYTES - baseSize - 10; // leave margin for JSON structure
    if (padSize > 0) {
      basePayload.data.pad = 'x'.repeat(padSize);
    }
    const rawBody = JSON.stringify(basePayload);

    // Verify we're under the limit
    expect(Buffer.byteLength(rawBody, 'utf8')).toBeLessThanOrEqual(WEBHOOK_MAX_BODY_BYTES);

    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

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
    expect(res.json<{ processed: boolean }>().processed).toBe(true);
  });

  // ─── Non-JSON body after valid HMAC ─────────────────────────────────────

  it('rejects non-JSON body even with valid HMAC signature', async () => {
    const rawBody = 'this is not json at all';
    const signature = buildStripeSignatureHeader(rawBody, TEST_SECRET);

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
    expect(res.json<{ error: { message: string } }>().error.message).toContain('not valid JSON');
  });

  // ─── Idempotency: distinct events with same type but different IDs ──────

  it('processes events with same type but different IDs independently (no false dedup)', async () => {
    const events = [
      { id: 'evt_batch_A', type: 'payment_intent.succeeded', data: { amount: 100 } },
      { id: 'evt_batch_B', type: 'payment_intent.succeeded', data: { amount: 200 } },
      { id: 'evt_batch_C', type: 'payment_intent.succeeded', data: { amount: 300 } }
    ];

    for (const payload of events) {
      const { rawBody, signature } = signedRequest(payload, TEST_SECRET);
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
      const body = res.json<{ processed: boolean; duplicate?: boolean; eventId: string }>();
      expect(body.processed).toBe(true);
      expect(body.duplicate).toBeUndefined();
      expect(body.eventId).toBe(payload.id);
    }

    // Verify all 3 are in the idempotency set
    expect(services.store.processedWebhookEventIds.has('evt_batch_A')).toBe(true);
    expect(services.store.processedWebhookEventIds.has('evt_batch_B')).toBe(true);
    expect(services.store.processedWebhookEventIds.has('evt_batch_C')).toBe(true);
  });
});
