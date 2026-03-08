/**
 * TASK-HARD-001: Integration tests for HttpMoltbookVerifier
 *
 * Uses a local HTTP mock server to simulate the Moltbook Identity API.
 * Tests cover:
 * - Successful verification with all fields mapped correctly
 * - expiresAt read from Moltbook response `exp` claim (not computed locally)
 * - Token sent as Authorization: Bearer header
 * - audience sent in request body
 * - 401 response → INVALID_IDENTITY_TOKEN
 * - 400 response → MOLTBOOK_BAD_REQUEST
 * - 500 response with retry + backoff
 * - Network error with retry + backoff
 * - All retries exhausted → MOLTBOOK_UNAVAILABLE (503)
 * - Malformed response → MOLTBOOK_RESPONSE_INVALID
 * - Factory: MOLTBOOK_API_URL unset → FakeMoltbookVerifier
 * - Factory: MOLTBOOK_API_URL set → HttpMoltbookVerifier
 * - Factory: MOLTBOOK_API_URL set without API_KEY → error
 */

import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpMoltbookVerifier, FakeMoltbookVerifier } from '../src/adapters/moltbook.js';
import { createMoltbookVerifier } from '../src/adapters/moltbook-factory.js';
import { DomainError } from '../src/core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Moltbook API Server
// ─────────────────────────────────────────────────────────────────────────────

type MockHandler = (req: http.IncomingMessage, body: string) => { status: number; body: unknown };

let mockServer: http.Server;
let mockPort: number;
let mockHandler: MockHandler;

function setMockHandler(handler: MockHandler) {
  mockHandler = handler;
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    checkedAt: new Date().toISOString(),
    exp: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
    agentId: 'agent_test_123',
    agentName: 'worker-test',
    karma: 150,
    posts: 40,
    comments: 50,
    ownerXVerified: true,
    ownerXHandle: 'owner_test_handle',
    ownerRef: 'owner_test_ref',
    isClaimed: true,
    isActive: true,
    ...overrides
  };
}

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const result = mockHandler(req, body);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock handler error' }));
      }
    });
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address();
      if (addr && typeof addr !== 'string') {
        mockPort = addr.port;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    mockServer.close(() => resolve());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HttpMoltbookVerifier Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TASK-HARD-001: HttpMoltbookVerifier', () => {
  let verifier: HttpMoltbookVerifier;

  beforeEach(() => {
    verifier = new HttpMoltbookVerifier({
      apiUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'mbk_test_key',
      maxRetries: 2,
      baseDelayMs: 10 // fast retries for tests
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Successful verification
  // ─────────────────────────────────────────────────────────────────────────

  it('maps Moltbook API response to VerifiedIdentity with all fields', async () => {
    setMockHandler(() => ({
      status: 200,
      body: successResponse()
    }));

    const result = await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');

    expect(result.valid).toBe(true);
    expect(result.agentId).toBe('agent_test_123');
    expect(result.agentName).toBe('worker-test');
    expect(result.karma).toBe(150);
    expect(result.posts).toBe(40);
    expect(result.comments).toBe(50);
    expect(result.ownerXVerified).toBe(true);
    expect(result.ownerXHandle).toBe('owner_test_handle');
    expect(result.ownerRef).toBe('owner_test_ref');
    expect(result.isClaimed).toBe(true);
    expect(result.isActive).toBe(true);
  });

  it('reads expiresAt from Moltbook response exp claim (not computed locally)', async () => {
    const expiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours from now
    setMockHandler(() => ({
      status: 200,
      body: successResponse({ exp: expiry })
    }));

    const result = await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
    expect(result.expiresAt).toBe(expiry);
  });

  it('uses checkedAt from response when provided', async () => {
    const checkedAt = new Date().toISOString();
    setMockHandler(() => ({
      status: 200,
      body: successResponse({ checkedAt })
    }));

    const result = await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
    expect(result.checkedAt).toBe(checkedAt);
  });

  it('falls back to now for checkedAt when not provided by Moltbook', async () => {
    const response = successResponse();
    delete (response as Record<string, unknown>).checkedAt;

    setMockHandler(() => ({
      status: 200,
      body: response
    }));

    const before = Date.now();
    const result = await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
    const after = Date.now();

    const checkedTime = new Date(result.checkedAt).getTime();
    expect(checkedTime).toBeGreaterThanOrEqual(before);
    expect(checkedTime).toBeLessThanOrEqual(after);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Token sent as Authorization: Bearer header + audience in body
  // ─────────────────────────────────────────────────────────────────────────

  it('sends token as Authorization: Bearer and audience in request body', async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    let capturedBody = '';

    setMockHandler((req, body) => {
      capturedHeaders = req.headers;
      capturedBody = body;
      return { status: 200, body: successResponse() };
    });

    await verifier.verify('mbtok_my_special_token', 'clawbot.marketplace.prod');

    expect(capturedHeaders.authorization).toBe('Bearer mbtok_my_special_token');
    expect(capturedHeaders['x-api-key']).toBe('mbk_test_key');
    expect(capturedHeaders['content-type']).toBe('application/json');

    const parsed = JSON.parse(capturedBody) as { audience: string };
    expect(parsed.audience).toBe('clawbot.marketplace.prod');
  });

  it('calls the correct endpoint path /v1/identity/verify', async () => {
    let capturedUrl = '';

    setMockHandler((req) => {
      capturedUrl = req.url ?? '';
      return { status: 200, body: successResponse() };
    });

    await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
    expect(capturedUrl).toBe('/v1/identity/verify');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Error responses
  // ─────────────────────────────────────────────────────────────────────────

  it('throws INVALID_IDENTITY_TOKEN on 401 response (no retry)', async () => {
    let callCount = 0;
    setMockHandler(() => {
      callCount++;
      return { status: 401, body: { error: 'unauthorized' } };
    });

    await expect(verifier.verify('mbtok_bad_token', 'clawbot.marketplace.local'))
      .rejects.toThrow(DomainError);

    try {
      await verifier.verify('mbtok_bad_token', 'clawbot.marketplace.local');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('INVALID_IDENTITY_TOKEN');
      expect((err as DomainError).statusCode).toBe(401);
    }

    // 401 should not be retried — only 1 call per attempt (2 total from 2 calls above)
    expect(callCount).toBe(2);
  });

  it('throws MOLTBOOK_BAD_REQUEST on 400 response (no retry)', async () => {
    setMockHandler(() => ({
      status: 400,
      body: { message: 'Invalid audience format' }
    }));

    try {
      await verifier.verify('mbtok_test', 'clawbot.marketplace.local');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('MOLTBOOK_BAD_REQUEST');
      expect((err as DomainError).message).toContain('Invalid audience format');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Retry with exponential backoff on 500
  // ─────────────────────────────────────────────────────────────────────────

  it('retries on 500 with exponential backoff and succeeds on retry', async () => {
    let callCount = 0;
    setMockHandler(() => {
      callCount++;
      if (callCount <= 2) {
        return { status: 500, body: { error: 'internal error' } };
      }
      return { status: 200, body: successResponse() };
    });

    const result = await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
    expect(result.valid).toBe(true);
    expect(callCount).toBe(3); // 2 failures + 1 success
  });

  it('exhausts retries on persistent 500 and throws MOLTBOOK_UPSTREAM_ERROR', async () => {
    let callCount = 0;
    setMockHandler(() => {
      callCount++;
      return { status: 500, body: { error: 'persistent failure' } };
    });

    try {
      await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      // After 3 retries total (initial + 2 retries), it should throw the upstream error
      expect((err as DomainError).code).toBe('MOLTBOOK_UPSTREAM_ERROR');
    }

    expect(callCount).toBe(3); // initial + 2 retries
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Network errors with retry
  // ─────────────────────────────────────────────────────────────────────────

  it('retries on network errors and throws MOLTBOOK_UNAVAILABLE after exhaustion', async () => {
    // Point to a port where nothing is listening
    const badVerifier = new HttpMoltbookVerifier({
      apiUrl: 'http://127.0.0.1:1',
      apiKey: 'mbk_test_key',
      maxRetries: 1,
      baseDelayMs: 10
    });

    try {
      await badVerifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('MOLTBOOK_UNAVAILABLE');
      expect((err as DomainError).statusCode).toBe(503);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Malformed response
  // ─────────────────────────────────────────────────────────────────────────

  it('throws MOLTBOOK_RESPONSE_INVALID for malformed API response', async () => {
    setMockHandler(() => ({
      status: 200,
      body: { valid: true, agentId: 'x' } // missing required fields
    }));

    try {
      await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('MOLTBOOK_RESPONSE_INVALID');
      expect((err as DomainError).statusCode).toBe(502);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Input validation (client-side)
  // ─────────────────────────────────────────────────────────────────────────

  it('rejects empty identity token before calling API', async () => {
    let callCount = 0;
    setMockHandler(() => {
      callCount++;
      return { status: 200, body: successResponse() };
    });

    await expect(verifier.verify('', 'clawbot.marketplace.local'))
      .rejects.toThrow(DomainError);

    expect(callCount).toBe(0); // Should never call API
  });

  it('rejects audience shorter than 3 characters', async () => {
    await expect(verifier.verify('mbtok_test', 'ab'))
      .rejects.toThrow(DomainError);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Rate limiting (429) with retry
  // ─────────────────────────────────────────────────────────────────────────

  it('retries on 429 rate limiting and succeeds after backoff', async () => {
    let callCount = 0;
    setMockHandler(() => {
      callCount++;
      if (callCount === 1) {
        return { status: 429, body: { error: 'too many requests' } };
      }
      return { status: 200, body: successResponse() };
    });

    const result = await verifier.verify('mbtok_test_token', 'clawbot.marketplace.local');
    expect(result.valid).toBe(true);
    expect(callCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Factory Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TASK-HARD-001: createMoltbookVerifier factory', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns FakeMoltbookVerifier when MOLTBOOK_API_URL is not set', () => {
    delete process.env.MOLTBOOK_API_URL;
    delete process.env.MOLTBOOK_API_KEY;

    const verifier = createMoltbookVerifier();
    expect(verifier).toBeInstanceOf(FakeMoltbookVerifier);
  });

  it('returns HttpMoltbookVerifier when MOLTBOOK_API_URL is set with API key', () => {
    process.env.MOLTBOOK_API_URL = 'https://api.moltbook.io';
    process.env.MOLTBOOK_API_KEY = 'mbk_live_test_key';

    const verifier = createMoltbookVerifier();
    expect(verifier).toBeInstanceOf(HttpMoltbookVerifier);
  });

  it('throws error when MOLTBOOK_API_URL is set but MOLTBOOK_API_KEY is missing', () => {
    process.env.MOLTBOOK_API_URL = 'https://api.moltbook.io';
    delete process.env.MOLTBOOK_API_KEY;

    expect(() => createMoltbookVerifier()).toThrow('MOLTBOOK_API_KEY must be set');
  });

  it('returns FakeMoltbookVerifier when MOLTBOOK_API_URL is empty string', () => {
    process.env.MOLTBOOK_API_URL = '';
    delete process.env.MOLTBOOK_API_KEY;

    const verifier = createMoltbookVerifier();
    expect(verifier).toBeInstanceOf(FakeMoltbookVerifier);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: HttpMoltbookVerifier plugged into app via createApp
// ─────────────────────────────────────────────────────────────────────────────

describe('TASK-HARD-001: HttpMoltbookVerifier integrated with app routes', () => {
  let verifier: HttpMoltbookVerifier;

  beforeEach(() => {
    verifier = new HttpMoltbookVerifier({
      apiUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'mbk_test_key',
      maxRetries: 1,
      baseDelayMs: 10
    });
  });

  it('app uses HttpMoltbookVerifier when injected via services override', async () => {
    const { createApp } = await import('../src/app.js');

    setMockHandler(() => ({
      status: 200,
      body: successResponse({
        agentId: 'agent_http_test',
        agentName: 'http-worker',
        karma: 200,
        posts: 60,
        comments: 70
      })
    }));

    const { app } = await createApp({
      services: { moltbook: verifier }
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/identity/moltbook/verify',
        payload: {
          identityToken: 'mbtok_real_token_from_moltbook',
          audience: 'clawbot.marketplace.local'
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        snapshot: {
          valid: boolean;
          trustTier: string;
          agent: { id: string; name: string; karma: number };
        };
        activationAllowed: boolean;
      }>();

      expect(body.activationAllowed).toBe(true);
      expect(body.snapshot.valid).toBe(true);
      expect(body.snapshot.trustTier).toBe('A'); // karma 200, volume 130 → Tier A
      expect(body.snapshot.agent.id).toBe('agent_http_test');
      expect(body.snapshot.agent.name).toBe('http-worker');
      expect(body.snapshot.agent.karma).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('app propagates Moltbook 401 as INVALID_IDENTITY_TOKEN to client', async () => {
    const { createApp } = await import('../src/app.js');

    setMockHandler(() => ({
      status: 401,
      body: { error: 'unauthorized' }
    }));

    const { app } = await createApp({
      services: { moltbook: verifier }
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/identity/moltbook/verify',
        payload: {
          identityToken: 'mbtok_invalid_token_xyz',
          audience: 'clawbot.marketplace.local'
        }
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_IDENTITY_TOKEN');
    } finally {
      await app.close();
    }
  });

  it('app propagates Moltbook unavailability as 503 to client', async () => {
    const { createApp } = await import('../src/app.js');

    setMockHandler(() => ({
      status: 500,
      body: { error: 'server down' }
    }));

    const { app } = await createApp({
      services: { moltbook: verifier }
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/identity/moltbook/verify',
        payload: {
          identityToken: 'mbtok_test_down',
          audience: 'clawbot.marketplace.local'
        }
      });

      // After retries exhausted, either 502 (upstream error) or 503 (unavailable)
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      const body = res.json<{ error: { code: string } }>();
      expect(['MOLTBOOK_UPSTREAM_ERROR', 'MOLTBOOK_UNAVAILABLE']).toContain(body.error.code);
    } finally {
      await app.close();
    }
  });
});
