import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bffFetch } from '../../components/api';

describe('bffFetch', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('calls fetch with /api/bff/{path}', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tasks: [] })
    });

    await bffFetch('tasks');

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/bff/tasks');
  });

  it('strips leading slash from path', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}'
    });

    await bffFetch('/tasks/public');

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/bff/tasks/public');
  });

  it('always includes content-type: application/json header', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}'
    });

    await bffFetch('tasks');

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((options.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('sets cache: no-store', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}'
    });

    await bffFetch('tasks');

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.cache).toBe('no-store');
  });

  it('passes method and body from init', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}'
    });

    await bffFetch('tasks', { method: 'POST', body: JSON.stringify({ title: 'test' }) });

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.body).toBe('{"title":"test"}');
  });

  it('merges extra headers from init with content-type', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}'
    });

    await bffFetch('tasks', { headers: { 'x-custom': 'value' } });

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((options.headers as Record<string, string>)['x-custom']).toBe('value');
    expect((options.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('returns parsed JSON for a successful response', async () => {
    const data = { agentId: 'agent_001', role: 'worker' };
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data)
    });

    const result = await bffFetch<{ agentId: string; role: string }>('sessions');
    expect(result).toEqual(data);
  });

  it('returns empty object for empty response body', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => ''
    });

    const result = await bffFetch('tasks/task_001/heartbeat');
    expect(result).toEqual({});
  });

  it('throws error with code and message on non-ok response', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Tier C cannot reserve.' } })
    });

    await expect(bffFetch('tasks/task_001/reserve')).rejects.toThrow(
      'FORBIDDEN: Tier C cannot reserve.'
    );
  });

  it('uses default code API_ERROR when error response has no code', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: 'Internal server error' } })
    });

    await expect(bffFetch('tasks')).rejects.toThrow('API_ERROR: Internal server error');
  });

  it('uses status-based fallback message when error body has no message', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '{}'
    });

    await expect(bffFetch('tasks')).rejects.toThrow('Request failed with status 502');
  });

  it('handles completely empty error body', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => ''
    });

    await expect(bffFetch('tasks')).rejects.toThrow('Request failed with status 503');
  });

  it('uses default code API_ERROR when error response body is empty', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => ''
    });

    await expect(bffFetch('tasks')).rejects.toThrow(/^API_ERROR:/);
  });
});
