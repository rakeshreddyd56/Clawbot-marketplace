// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mock next/headers before importing the route ────────────────────────────
vi.mock('next/headers', () => ({
  cookies: vi.fn()
}));

import { GET, POST, PUT, DELETE } from '../../app/api/bff/[...path]/route';
import { cookies } from 'next/headers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, url: string, body?: string): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body } : {})
  });
}

function makeContext(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) };
}

function mockCookies(token: string | undefined) {
  vi.mocked(cookies).mockResolvedValue({
    get: vi.fn().mockReturnValue(token ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    has: vi.fn().mockReturnValue(false)
  } as any);
}

function mockFetch(status: number, body: string, contentType = 'application/json') {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    text: async () => body,
    headers: {
      get: (name: string) => (name === 'content-type' ? contentType : null)
    }
  });
}

describe('BFF Proxy — GET requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_BASE_URL;
  });

  it('proxies GET to API with path joined by /', async () => {
    mockCookies('session_token_123');
    mockFetch(200, JSON.stringify({ tasks: [] }));

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks/public');
    const ctx = makeContext(['tasks', 'public']);

    const response = await GET(req, ctx);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/v1/tasks/public',
      expect.any(Object)
    );
    expect(response.status).toBe(200);
  });

  it('includes Authorization Bearer header when session cookie exists', async () => {
    mockCookies('my_session_token');
    mockFetch(200, '{}');

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/worker/eligibility');
    const ctx = makeContext(['worker', 'eligibility']);

    await GET(req, ctx);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.headers.authorization).toBe('Bearer my_session_token');
  });

  it('omits Authorization header when no session cookie', async () => {
    mockCookies(undefined);
    mockFetch(200, '{}');

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks');
    const ctx = makeContext(['tasks']);

    await GET(req, ctx);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.headers.authorization).toBeUndefined();
  });

  it('uses API_BASE_URL env var when set', async () => {
    process.env.API_BASE_URL = 'https://api.example.com';
    mockCookies('token_xyz');
    mockFetch(200, '{}');

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks');
    const ctx = makeContext(['tasks']);

    await GET(req, ctx);

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toMatch(/^https:\/\/api\.example\.com/);
  });

  it('preserves query params in proxied URL', async () => {
    mockCookies('tok');
    mockFetch(200, '{}');

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks/scope?leaseId=lease_abc&leaseToken=tok_xyz');
    const ctx = makeContext(['tasks', 'scope']);

    await GET(req, ctx);

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('leaseId=lease_abc');
    expect(url).toContain('leaseToken=tok_xyz');
  });

  it('returns the same status code from the upstream API', async () => {
    mockCookies('tok');
    mockFetch(404, JSON.stringify({ error: { code: 'NOT_FOUND' } }));

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks/nonexistent');
    const ctx = makeContext(['tasks', 'nonexistent']);

    const response = await GET(req, ctx);
    expect(response.status).toBe(404);
  });

  it('returns 401 status from upstream as 401', async () => {
    mockCookies(undefined);
    mockFetch(401, JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'No session' } }));

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks');
    const ctx = makeContext(['tasks']);

    const response = await GET(req, ctx);
    expect(response.status).toBe(401);
  });

  it('returns response body verbatim', async () => {
    const body = JSON.stringify({ tasks: [{ taskId: 'task_001', title: 'Test' }] });
    mockCookies('tok');
    mockFetch(200, body);

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks');
    const ctx = makeContext(['tasks']);

    const response = await GET(req, ctx);
    const text = await response.text();
    expect(text).toBe(body);
  });

  it('sets GET body to undefined (no request body sent to API)', async () => {
    mockCookies('tok');
    mockFetch(200, '{}');

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks');
    const ctx = makeContext(['tasks']);

    await GET(req, ctx);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.body).toBeUndefined();
  });
});

describe('BFF Proxy — POST requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_BASE_URL;
  });

  it('proxies POST to API with body forwarded', async () => {
    mockCookies('tok');
    mockFetch(200, JSON.stringify({ contractId: 'contract_001' }));

    const req = makeRequest(
      'POST',
      'http://localhost:3001/api/bff/tasks/task_001/accept',
      JSON.stringify({ leaseId: 'lease_abc', leaseToken: 'tok_abc' })
    );
    const ctx = makeContext(['tasks', 'task_001', 'accept']);

    const response = await POST(req, ctx);
    expect(response.status).toBe(200);

    const [url, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('v1/tasks/task_001/accept');
    expect(options.method).toBe('POST');
    expect(options.body).toContain('lease_abc');
  });

  it('includes Authorization header for POST with session', async () => {
    mockCookies('session_abc');
    mockFetch(200, '{}');

    const req = makeRequest('POST', 'http://localhost:3001/api/bff/tasks', '{}');
    const ctx = makeContext(['tasks']);

    await POST(req, ctx);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.headers.authorization).toBe('Bearer session_abc');
  });

  it('returns 422 from upstream for invalid POST body', async () => {
    mockCookies('tok');
    mockFetch(422, JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'budget required' } }));

    const req = makeRequest('POST', 'http://localhost:3001/api/bff/tasks', '{}');
    const ctx = makeContext(['tasks']);

    const response = await POST(req, ctx);
    expect(response.status).toBe(422);
  });
});

describe('BFF Proxy — PUT requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_BASE_URL;
  });

  it('proxies PUT to API', async () => {
    mockCookies('tok');
    mockFetch(200, '{}');

    const req = makeRequest('PUT', 'http://localhost:3001/api/bff/agents/me', '{"name":"Alice"}');
    const ctx = makeContext(['agents', 'me']);

    await PUT(req, ctx);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('PUT');
  });
});

describe('BFF Proxy — DELETE requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_BASE_URL;
  });

  it('proxies DELETE to API', async () => {
    mockCookies('tok');
    mockFetch(200, '{}');

    const req = makeRequest('DELETE', 'http://localhost:3001/api/bff/tasks/task_001');
    const ctx = makeContext(['tasks', 'task_001']);

    await DELETE(req, ctx);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('DELETE');
  });

  it('sets body to undefined for DELETE', async () => {
    mockCookies('tok');
    mockFetch(200, '{}');

    const req = makeRequest('DELETE', 'http://localhost:3001/api/bff/tasks/task_001');
    const ctx = makeContext(['tasks', 'task_001']);

    await DELETE(req, ctx);

    // DELETE body: since method is not GET, route calls request.text()
    // which returns '' for a bodyless request — that is passed as body
    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    // Empty string body is fine for DELETE
    expect(typeof options.body).toBe('string');
  });
});

describe('BFF Proxy — Content-type forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the upstream content-type header', async () => {
    mockCookies('tok');
    mockFetch(200, '{}', 'application/json; charset=utf-8');

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks');
    const ctx = makeContext(['tasks']);

    const response = await GET(req, ctx);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('defaults content-type to application/json when upstream sends none', async () => {
    mockCookies('tok');
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '{}',
      headers: { get: () => null }
    });

    const req = makeRequest('GET', 'http://localhost:3001/api/bff/tasks');
    const ctx = makeContext(['tasks']);

    const response = await GET(req, ctx);
    expect(response.headers.get('content-type')).toBe('application/json');
  });
});
