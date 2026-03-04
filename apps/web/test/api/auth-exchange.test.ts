// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mock next/headers before importing the route ────────────────────────────
vi.mock('next/headers', () => ({
  cookies: vi.fn()
}));

import { POST } from '../../app/api/auth/exchange/route';
import { cookies } from 'next/headers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeExchangeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3001/api/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

interface MockCookies {
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function makeCookiesMock(): MockCookies {
  return {
    set: vi.fn(),
    delete: vi.fn(),
    get: vi.fn()
  };
}

describe('POST /api/auth/exchange', () => {
  let cookiesMock: MockCookies;

  beforeEach(() => {
    vi.clearAllMocks();
    cookiesMock = makeCookiesMock();
    vi.mocked(cookies).mockResolvedValue(cookiesMock as any);
    delete process.env.API_BASE_URL;
  });

  it('forwards POST body to /v1/sessions/exchange on the API', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'session_token_abc',
        agentId: 'agent_001',
        role: 'worker',
        trustTier: 'A',
        expiresAt: '2026-03-02T08:00:00Z'
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_worker', role: 'worker' });
    await POST(req);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/v1/sessions/exchange',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sets httpOnly bff_session cookie on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'session_token_abc',
        agentId: 'agent_001',
        role: 'worker',
        trustTier: 'A',
        expiresAt: '2026-03-02T08:00:00Z'
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_worker', role: 'worker' });
    await POST(req);

    expect(cookiesMock.set).toHaveBeenCalledWith(
      'bff_session',
      'session_token_abc',
      expect.objectContaining({ httpOnly: true })
    );
  });

  it('sets sameSite: lax on the session cookie', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'tok',
        agentId: 'a',
        role: 'requester',
        trustTier: 'B',
        expiresAt: ''
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_x', role: 'requester' });
    await POST(req);

    const cookieOptions = cookiesMock.set.mock.calls[0][2];
    expect(cookieOptions.sameSite).toBe('lax');
  });

  it('sets 8-hour maxAge on session cookie', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'tok',
        agentId: 'a',
        role: 'worker',
        trustTier: 'A',
        expiresAt: ''
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_x', role: 'worker' });
    await POST(req);

    const cookieOptions = cookiesMock.set.mock.calls[0][2];
    expect(cookieOptions.maxAge).toBe(60 * 60 * 8);
  });

  it('returns agentId, role, trustTier, expiresAt in response body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'session_token_abc',
        agentId: 'agent_worker_001',
        role: 'worker',
        trustTier: 'A',
        expiresAt: '2026-03-02T08:00:00Z'
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_worker', role: 'worker' });
    const response = await POST(req);
    const body = await response.json();

    expect(body).toEqual({
      agentId: 'agent_worker_001',
      role: 'worker',
      trustTier: 'A',
      expiresAt: '2026-03-02T08:00:00Z'
    });
  });

  it('does NOT leak the session token in the response body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'secret_token_xyz',
        agentId: 'agent_001',
        role: 'worker',
        trustTier: 'A',
        expiresAt: ''
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_worker', role: 'worker' });
    const response = await POST(req);
    const body = await response.json();

    expect(body.token).toBeUndefined();
  });

  it('returns upstream error response without setting cookie on failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: 'TOKEN_INVALID', message: 'Identity token is invalid.' }
      })
    });

    const req = makeExchangeRequest({ identityToken: 'bad_token', role: 'worker' });
    const response = await POST(req);

    expect(response.status).toBe(401);
    expect(cookiesMock.set).not.toHaveBeenCalled();
  });

  it('returns upstream error body for non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: { code: 'HARD_BLOCKED', message: 'Account blocked by Moltbook.' }
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_blocked', role: 'worker' });
    const response = await POST(req);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('HARD_BLOCKED');
  });

  it('uses API_BASE_URL env var when set', async () => {
    process.env.API_BASE_URL = 'https://api.prod.example.com';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'tok',
        agentId: 'a',
        role: 'worker',
        trustTier: 'A',
        expiresAt: ''
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_x', role: 'worker' });
    await POST(req);

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('api.prod.example.com');
  });

  it('sets cookie path to /', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'tok',
        agentId: 'a',
        role: 'worker',
        trustTier: 'A',
        expiresAt: ''
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_x', role: 'worker' });
    await POST(req);

    const cookieOptions = cookiesMock.set.mock.calls[0][2];
    expect(cookieOptions.path).toBe('/');
  });

  it('returns 200 status code on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'tok',
        agentId: 'a',
        role: 'worker',
        trustTier: 'A',
        expiresAt: ''
      })
    });

    const req = makeExchangeRequest({ identityToken: 'mbtok_x', role: 'worker' });
    const response = await POST(req);

    expect(response.status).toBe(200);
  });

  it('forwards the full request body to the API', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'tok',
        agentId: 'a',
        role: 'moderator',
        trustTier: 'A',
        expiresAt: ''
      })
    });

    const payload = { identityToken: 'mbtok_mod_alpha', role: 'moderator', extra: 'data' };
    const req = makeExchangeRequest(payload);
    await POST(req);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body).toEqual(payload);
  });
});
