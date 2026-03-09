/**
 * TASK-HARD-002: HttpStripeAdapter integration tests.
 *
 * Tests the real HttpStripeAdapter against a local mock HTTP server that
 * simulates Stripe API responses. Verifies:
 *
 * 1. createTopup() — PaymentIntent creation with idempotency key
 * 2. createPayout() — Payout creation with Stripe-Account header (Connect)
 * 3. Stripe API error handling (4xx, 5xx)
 * 4. Exponential backoff retry on transient failures
 * 5. Rate limiting (429) with Retry-After header
 * 6. Idempotency keys present on all requests
 * 7. Amount conversion (dollars → cents)
 * 8. Webhook signature verification via shared implementation
 * 9. Connected account resolver for Connect payouts
 * 10. Factory: STRIPE_API_KEY unset → FakeStripeAdapter
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HttpStripeAdapter,
  FakeStripeAdapter,
  StripeApiError,
  WebhookSignatureError,
  buildStripeSignatureHeader,
  type HttpStripeAdapterConfig
} from '../src/adapters/stripe.js';
import { createStripeAdapter } from '../src/adapters/stripe-factory.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Stripe HTTP server
// ─────────────────────────────────────────────────────────────────────────────

type MockHandler = (
  method: string,
  path: string,
  body: string,
  headers: Record<string, string | string[] | undefined>
) => { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

let mockServer: Server;
let mockPort: number;
let mockHandler: MockHandler;
/** Captured requests for assertion */
let capturedRequests: {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}[] = [];

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const captured = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          body,
          headers: req.headers as Record<string, string | string[] | undefined>
        };
        capturedRequests.push(captured);

        const result = mockHandler(captured.method, captured.path, captured.body, captured.headers);
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) {
            res.setHeader(k, v);
          }
        }
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
    });

    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address();
      if (addr && typeof addr === 'object') {
        mockPort = addr.port;
      }
      resolve();
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer.close(() => resolve());
  });
}

function createTestAdapter(overrides?: Partial<HttpStripeAdapterConfig>): HttpStripeAdapter {
  return new HttpStripeAdapter({
    apiKey: 'sk_test_mock_key',
    webhookSecret: 'whsec_test_mock_secret',
    apiBaseUrl: `http://127.0.0.1:${mockPort}`,
    maxRetries: 0, // No retries by default for fast tests
    baseDelayMs: 10,
    ...overrides
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

// TASK-HARD-002: HttpStripeAdapter real Stripe Connect implementation.
describe('TASK-HARD-002: HttpStripeAdapter integration tests', () => {
  beforeAll(async () => {
    await startMockServer();
  });

  afterAll(async () => {
    await stopMockServer();
  });

  beforeEach(() => {
    capturedRequests = [];
    // Default handler — returns a 200 with empty object
    mockHandler = () => ({ status: 200, body: {} });
  });

  // ─── createTopup ───────────────────────────────────────────────────────────

  describe('createTopup()', () => {
    it('creates a PaymentIntent and returns topupId + status', async () => {
      mockHandler = (_method, _path, _body, _headers) => ({
        status: 200,
        body: {
          id: 'pi_test_123',
          object: 'payment_intent',
          status: 'succeeded',
          amount: 5000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      const result = await adapter.createTopup('agent_001', 50);

      expect(result.topupId).toBe('pi_test_123');
      expect(result.status).toBe('succeeded');
    });

    it('sends correct amount in cents (dollars × 100)', async () => {
      mockHandler = (_method, _path, body) => {
        const params = new URLSearchParams(body);
        expect(params.get('amount')).toBe('10050'); // 100.50 * 100
        return {
          status: 200,
          body: {
            id: 'pi_cents_test',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 10050,
            currency: 'usd'
          }
        };
      };

      const adapter = createTestAdapter();
      await adapter.createTopup('agent_cents', 100.50);
    });

    it('includes Idempotency-Key header on all requests', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'pi_idem_test',
          object: 'payment_intent',
          status: 'succeeded',
          amount: 1000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      await adapter.createTopup('agent_idem', 10);

      expect(capturedRequests).toHaveLength(1);
      const req = capturedRequests[0];
      expect(req.headers['idempotency-key']).toBeTruthy();
      expect(String(req.headers['idempotency-key']).startsWith('stripe_idem_')).toBe(true);
    });

    it('includes Bearer authorization header', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'pi_auth_test',
          object: 'payment_intent',
          status: 'succeeded',
          amount: 1000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter({ apiKey: 'sk_test_my_key_123' });
      await adapter.createTopup('agent_auth', 10);

      expect(capturedRequests[0].headers['authorization']).toBe('Bearer sk_test_my_key_123');
    });

    it('includes Stripe-Version header', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'pi_version_test',
          object: 'payment_intent',
          status: 'succeeded',
          amount: 1000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      await adapter.createTopup('agent_version', 10);

      expect(capturedRequests[0].headers['stripe-version']).toBe('2024-12-18.acacia');
    });

    it('sends agent_id and purpose in metadata', async () => {
      mockHandler = (_method, _path, body) => {
        const params = new URLSearchParams(body);
        expect(params.get('metadata[agent_id]')).toBe('agent_meta_test');
        expect(params.get('metadata[purpose]')).toBe('wallet_topup');
        return {
          status: 200,
          body: {
            id: 'pi_meta_test',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 1000,
            currency: 'usd'
          }
        };
      };

      const adapter = createTestAdapter();
      await adapter.createTopup('agent_meta_test', 10);
    });

    it('sends confirm=true to auto-confirm the PaymentIntent', async () => {
      mockHandler = (_method, _path, body) => {
        const params = new URLSearchParams(body);
        expect(params.get('confirm')).toBe('true');
        return {
          status: 200,
          body: {
            id: 'pi_confirm_test',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 1000,
            currency: 'usd'
          }
        };
      };

      const adapter = createTestAdapter();
      await adapter.createTopup('agent_confirm', 10);
    });

    it('throws StripeApiError when PaymentIntent status is not succeeded', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'pi_pending',
          object: 'payment_intent',
          status: 'requires_action',
          amount: 5000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      await expect(adapter.createTopup('agent_fail', 50)).rejects.toThrow(StripeApiError);
      await expect(adapter.createTopup('agent_fail', 50)).rejects.toThrow(/requires_action/);
    });

    it('throws StripeApiError on Stripe 4xx error response', async () => {
      mockHandler = () => ({
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            message: 'Amount must be at least $0.50',
            code: 'amount_too_small'
          }
        }
      });

      const adapter = createTestAdapter();
      await expect(adapter.createTopup('agent_err', 0.01)).rejects.toThrow(StripeApiError);
      await expect(adapter.createTopup('agent_err', 0.01)).rejects.toThrow(/amount_too_small/);
    });

    it('uses custom currency when configured', async () => {
      mockHandler = (_method, _path, body) => {
        const params = new URLSearchParams(body);
        expect(params.get('currency')).toBe('eur');
        return {
          status: 200,
          body: {
            id: 'pi_eur_test',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 1000,
            currency: 'eur'
          }
        };
      };

      const adapter = createTestAdapter({ currency: 'eur' });
      await adapter.createTopup('agent_eur', 10);
    });
  });

  // ─── createPayout ──────────────────────────────────────────────────────────

  describe('createPayout()', () => {
    it('creates a payout and returns payoutId + status', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'po_test_456',
          object: 'payout',
          status: 'pending',
          amount: 5000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      const result = await adapter.createPayout('agent_payout', 50);

      expect(result.payoutId).toBe('po_test_456');
      expect(result.status).toBe('pending');
    });

    it('returns paid status when Stripe payout is already paid', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'po_paid_test',
          object: 'payout',
          status: 'paid',
          amount: 2000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      const result = await adapter.createPayout('agent_paid', 20);

      expect(result.status).toBe('paid');
    });

    it('maps in_transit status to pending', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'po_transit_test',
          object: 'payout',
          status: 'in_transit',
          amount: 3000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      const result = await adapter.createPayout('agent_transit', 30);

      expect(result.status).toBe('pending');
    });

    it('includes Idempotency-Key header', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'po_idem_test',
          object: 'payout',
          status: 'pending',
          amount: 1000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      await adapter.createPayout('agent_idem_payout', 10);

      expect(capturedRequests).toHaveLength(1);
      expect(String(capturedRequests[0].headers['idempotency-key']).startsWith('stripe_idem_')).toBe(true);
    });

    it('sends amount in cents', async () => {
      mockHandler = (_method, _path, body) => {
        const params = new URLSearchParams(body);
        expect(params.get('amount')).toBe('7500'); // 75 * 100
        return {
          status: 200,
          body: {
            id: 'po_cents_test',
            object: 'payout',
            status: 'pending',
            amount: 7500,
            currency: 'usd'
          }
        };
      };

      const adapter = createTestAdapter();
      await adapter.createPayout('agent_payout_cents', 75);
    });

    it('sends payout metadata with agent_id and purpose', async () => {
      mockHandler = (_method, _path, body) => {
        const params = new URLSearchParams(body);
        expect(params.get('metadata[agent_id]')).toBe('agent_meta_payout');
        expect(params.get('metadata[purpose]')).toBe('agent_payout');
        return {
          status: 200,
          body: {
            id: 'po_meta_test',
            object: 'payout',
            status: 'pending',
            amount: 1000,
            currency: 'usd'
          }
        };
      };

      const adapter = createTestAdapter();
      await adapter.createPayout('agent_meta_payout', 10);
    });

    it('includes Stripe-Account header when connectedAccountResolver returns an ID', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'po_connect_test',
          object: 'payout',
          status: 'pending',
          amount: 5000,
          currency: 'usd'
        }
      });

      const resolver = async (agentId: string) => {
        if (agentId === 'agent_connected') return 'acct_connect_123';
        return undefined;
      };

      const adapter = createTestAdapter({ connectedAccountResolver: resolver });
      await adapter.createPayout('agent_connected', 50);

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].headers['stripe-account']).toBe('acct_connect_123');
    });

    it('omits Stripe-Account header when connectedAccountResolver returns undefined', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'po_no_connect',
          object: 'payout',
          status: 'pending',
          amount: 5000,
          currency: 'usd'
        }
      });

      const resolver = async (_agentId: string) => undefined;

      const adapter = createTestAdapter({ connectedAccountResolver: resolver });
      await adapter.createPayout('agent_unknown', 50);

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].headers['stripe-account']).toBeUndefined();
    });

    it('omits Stripe-Account header when no resolver is configured', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'po_no_resolver',
          object: 'payout',
          status: 'pending',
          amount: 5000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter(); // No connectedAccountResolver
      await adapter.createPayout('agent_no_resolver', 50);

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].headers['stripe-account']).toBeUndefined();
    });
  });

  // ─── Retry and error handling ──────────────────────────────────────────────

  describe('retry and error handling', () => {
    it('retries on 5xx server errors with exponential backoff', async () => {
      let requestCount = 0;
      mockHandler = () => {
        requestCount++;
        if (requestCount <= 2) {
          return { status: 500, body: { error: { message: 'Internal error' } } };
        }
        return {
          status: 200,
          body: {
            id: 'pi_retry_success',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 1000,
            currency: 'usd'
          }
        };
      };

      const adapter = createTestAdapter({ maxRetries: 3, baseDelayMs: 10 });
      const result = await adapter.createTopup('agent_retry', 10);

      expect(result.topupId).toBe('pi_retry_success');
      expect(requestCount).toBe(3); // 2 failures + 1 success
    });

    it('retries on 429 rate limit', async () => {
      let requestCount = 0;
      mockHandler = () => {
        requestCount++;
        if (requestCount === 1) {
          return {
            status: 429,
            body: { error: { message: 'Rate limited' } },
            headers: { 'retry-after': '0' }
          };
        }
        return {
          status: 200,
          body: {
            id: 'pi_ratelimit_success',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 1000,
            currency: 'usd'
          }
        };
      };

      const adapter = createTestAdapter({ maxRetries: 2, baseDelayMs: 10 });
      const result = await adapter.createTopup('agent_ratelimit', 10);

      expect(result.topupId).toBe('pi_ratelimit_success');
      expect(requestCount).toBe(2);
    });

    it('throws StripeApiError after exhausting all retries on 5xx', async () => {
      mockHandler = () => ({
        status: 502,
        body: { error: { message: 'Bad gateway' } }
      });

      const adapter = createTestAdapter({ maxRetries: 1, baseDelayMs: 10 });
      await expect(adapter.createTopup('agent_exhaust', 10)).rejects.toThrow(StripeApiError);
    });

    it('throws StripeApiError with 400 status for Stripe client errors', async () => {
      mockHandler = () => ({
        status: 402,
        body: {
          error: {
            type: 'card_error',
            message: 'Card declined',
            code: 'card_declined'
          }
        }
      });

      const adapter = createTestAdapter();
      try {
        await adapter.createTopup('agent_card_err', 10);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeApiError);
        expect((err as StripeApiError).statusCode).toBe(400);
      }
    });

    it('throws StripeApiError with 502 status for Stripe server errors', async () => {
      mockHandler = () => ({
        status: 500,
        body: { error: { message: 'Internal server error' } }
      });

      const adapter = createTestAdapter({ maxRetries: 0 });
      try {
        await adapter.createTopup('agent_5xx', 10);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeApiError);
        expect((err as StripeApiError).statusCode).toBe(502);
      }
    });

    it('uses same Idempotency-Key across retries', async () => {
      let requestCount = 0;
      mockHandler = () => {
        requestCount++;
        if (requestCount === 1) {
          return { status: 500, body: { error: { message: 'Server error' } } };
        }
        return {
          status: 200,
          body: {
            id: 'pi_idem_retry',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 1000,
            currency: 'usd'
          }
        };
      };

      const adapter = createTestAdapter({ maxRetries: 2, baseDelayMs: 10 });
      await adapter.createTopup('agent_idem_retry', 10);

      expect(capturedRequests).toHaveLength(2);
      // Same idempotency key on both requests
      expect(capturedRequests[0].headers['idempotency-key'])
        .toBe(capturedRequests[1].headers['idempotency-key']);
    });
  });

  // ─── Webhook signature verification ────────────────────────────────────────

  describe('verifyWebhookSignature()', () => {
    const secret = 'whsec_test_webhook_verify';

    it('verifies a valid webhook signature and returns parsed event', () => {
      const adapter = createTestAdapter({ webhookSecret: secret });
      const payload = { id: 'evt_test_001', type: 'payment_intent.succeeded', data: { amount: 1000 } };
      const rawBody = JSON.stringify(payload);
      const sig = buildStripeSignatureHeader(rawBody, secret);

      const event = adapter.verifyWebhookSignature(rawBody, sig);

      expect(event.id).toBe('evt_test_001');
      expect(event.type).toBe('payment_intent.succeeded');
      expect(event.data).toEqual({ amount: 1000 });
    });

    it('rejects a forged signature', () => {
      const adapter = createTestAdapter({ webhookSecret: secret });
      const rawBody = JSON.stringify({ id: 'evt_forged', type: 'test', data: {} });
      const forgedSig = buildStripeSignatureHeader(rawBody, 'whsec_wrong_key');

      expect(() => adapter.verifyWebhookSignature(rawBody, forgedSig))
        .toThrow(WebhookSignatureError);
    });

    it('rejects an expired timestamp', () => {
      const adapter = createTestAdapter({ webhookSecret: secret });
      const rawBody = JSON.stringify({ id: 'evt_stale', type: 'test', data: {} });
      const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
      const sig = buildStripeSignatureHeader(rawBody, secret, staleTs);

      expect(() => adapter.verifyWebhookSignature(rawBody, sig))
        .toThrow(/tolerance/);
    });

    it('rejects empty signature header', () => {
      const adapter = createTestAdapter({ webhookSecret: secret });
      const rawBody = JSON.stringify({ id: 'evt_no_sig', type: 'test', data: {} });

      expect(() => adapter.verifyWebhookSignature(rawBody, ''))
        .toThrow(WebhookSignatureError);
    });

    it('supports Stripe key rotation (multiple v1 signatures)', () => {
      const adapter = createTestAdapter({ webhookSecret: secret });
      const payload = { id: 'evt_rotation', type: 'test.event', data: {} };
      const rawBody = JSON.stringify(payload);
      const t = Math.floor(Date.now() / 1000);

      // Build a header with two v1 sigs: old key (wrong) + new key (correct)
      const signedPayload = `${t}.${rawBody}`;
      const oldKeyHmac = 'a'.repeat(64); // fake old sig
      const crypto = require('node:crypto');
      const correctHmac = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
      const multiSigHeader = `t=${t},v1=${oldKeyHmac},v1=${correctHmac}`;

      const event = adapter.verifyWebhookSignature(rawBody, multiSigHeader);
      expect(event.id).toBe('evt_rotation');
    });

    it('validates event body with Zod (rejects missing id)', () => {
      const adapter = createTestAdapter({ webhookSecret: secret });
      // Valid HMAC but body missing 'id' field
      const rawBody = JSON.stringify({ type: 'test', data: {} });
      const sig = buildStripeSignatureHeader(rawBody, secret);

      expect(() => adapter.verifyWebhookSignature(rawBody, sig))
        .toThrow(WebhookSignatureError);
    });
  });

  // ─── Factory ───────────────────────────────────────────────────────────────

  describe('createStripeAdapter() factory', () => {
    it('returns FakeStripeAdapter when STRIPE_API_KEY is unset', () => {
      const original = process.env.STRIPE_API_KEY;
      try {
        delete process.env.STRIPE_API_KEY;
        const adapter = createStripeAdapter();
        expect(adapter).toBeInstanceOf(FakeStripeAdapter);
      } finally {
        if (original !== undefined) process.env.STRIPE_API_KEY = original;
        else delete process.env.STRIPE_API_KEY;
      }
    });

    it('returns HttpStripeAdapter when STRIPE_API_KEY is set', () => {
      const origKey = process.env.STRIPE_API_KEY;
      const origSecret = process.env.STRIPE_WEBHOOK_SECRET;
      try {
        process.env.STRIPE_API_KEY = 'sk_test_factory_test';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_factory_test';
        const adapter = createStripeAdapter();
        expect(adapter).toBeInstanceOf(HttpStripeAdapter);
      } finally {
        if (origKey !== undefined) process.env.STRIPE_API_KEY = origKey;
        else delete process.env.STRIPE_API_KEY;
        if (origSecret !== undefined) process.env.STRIPE_WEBHOOK_SECRET = origSecret;
        else delete process.env.STRIPE_WEBHOOK_SECRET;
      }
    });

    it('throws when STRIPE_API_KEY is set but STRIPE_WEBHOOK_SECRET is missing', () => {
      const origKey = process.env.STRIPE_API_KEY;
      const origSecret = process.env.STRIPE_WEBHOOK_SECRET;
      try {
        process.env.STRIPE_API_KEY = 'sk_test_no_secret';
        delete process.env.STRIPE_WEBHOOK_SECRET;
        expect(() => createStripeAdapter()).toThrow('STRIPE_WEBHOOK_SECRET must be set');
      } finally {
        if (origKey !== undefined) process.env.STRIPE_API_KEY = origKey;
        else delete process.env.STRIPE_API_KEY;
        if (origSecret !== undefined) process.env.STRIPE_WEBHOOK_SECRET = origSecret;
        else delete process.env.STRIPE_WEBHOOK_SECRET;
      }
    });
  });

  // ─── URL and API path ─────────────────────────────────────────────────────

  describe('API paths and URL construction', () => {
    it('sends topup request to /v1/payment_intents', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'pi_path_test',
          object: 'payment_intent',
          status: 'succeeded',
          amount: 1000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      await adapter.createTopup('agent_path', 10);

      expect(capturedRequests[0].path).toBe('/v1/payment_intents');
    });

    it('sends payout request to /v1/payouts', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'po_path_test',
          object: 'payout',
          status: 'pending',
          amount: 1000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter();
      await adapter.createPayout('agent_path_payout', 10);

      expect(capturedRequests[0].path).toBe('/v1/payouts');
    });

    it('strips trailing slashes from apiBaseUrl', async () => {
      mockHandler = () => ({
        status: 200,
        body: {
          id: 'pi_slash_test',
          object: 'payment_intent',
          status: 'succeeded',
          amount: 1000,
          currency: 'usd'
        }
      });

      const adapter = createTestAdapter({
        apiBaseUrl: `http://127.0.0.1:${mockPort}///`
      });
      await adapter.createTopup('agent_slash', 10);

      expect(capturedRequests[0].path).toBe('/v1/payment_intents');
    });
  });
});
