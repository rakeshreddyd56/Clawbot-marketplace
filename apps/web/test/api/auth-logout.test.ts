// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock next/headers before importing the route ────────────────────────────
vi.mock('next/headers', () => ({
  cookies: vi.fn()
}));

import { POST } from '../../app/api/auth/logout/route';
import { cookies } from 'next/headers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

describe('POST /api/auth/logout', () => {
  let cookiesMock: MockCookies;

  beforeEach(() => {
    vi.clearAllMocks();
    cookiesMock = makeCookiesMock();
    vi.mocked(cookies).mockResolvedValue(cookiesMock as any);
  });

  it('returns { ok: true } in the response body', async () => {
    const response = await POST();
    const body = await response.json();
    expect(body).toEqual({ ok: true });
  });

  it('returns HTTP 200 status', async () => {
    const response = await POST();
    expect(response.status).toBe(200);
  });

  it('deletes the bff_session cookie', async () => {
    await POST();
    expect(cookiesMock.delete).toHaveBeenCalledWith('bff_session');
  });

  it('calls cookies() to access the cookie store', async () => {
    await POST();
    expect(vi.mocked(cookies)).toHaveBeenCalledTimes(1);
  });

  it('does NOT call set on the cookie store', async () => {
    await POST();
    expect(cookiesMock.set).not.toHaveBeenCalled();
  });

  it('does NOT call fetch (no upstream API call needed)', async () => {
    global.fetch = vi.fn();
    await POST();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is idempotent — calling twice still returns { ok: true }', async () => {
    const res1 = await POST();
    const body1 = await res1.json();
    expect(body1).toEqual({ ok: true });

    const res2 = await POST();
    const body2 = await res2.json();
    expect(body2).toEqual({ ok: true });
  });

  it('deletes the exact cookie name "bff_session" (no typos)', async () => {
    await POST();
    const deletedKey = cookiesMock.delete.mock.calls[0][0];
    expect(deletedKey).toBe('bff_session');
  });
});
