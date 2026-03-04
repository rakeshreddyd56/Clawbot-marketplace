import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RealtimeFeed } from '../../components/realtime-feed';
import { lastWebSocket } from '../setup';

// Note: WebSocket is mocked globally in test/setup.ts

describe('RealtimeFeed', () => {
  beforeEach(() => {
    // Clear any env var so the default URL is used
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
  });

  it('renders the "Realtime" badge', () => {
    render(<RealtimeFeed channels={['task.*']} />);
    expect(screen.getByText('Realtime')).toBeInTheDocument();
  });

  it('shows "Waiting for events\u2026" when no messages received', () => {
    render(<RealtimeFeed channels={['task.*']} />);
    expect(screen.getByText('Waiting for events\u2026')).toBeInTheDocument();
  });

  it('creates a WebSocket connection on mount', () => {
    render(<RealtimeFeed channels={['task.*', 'contract.*']} />);
    // Verify a WebSocket was created (lastWebSocket is set in MockWebSocket constructor)
    expect(lastWebSocket).not.toBeNull();
  });

  it('connects to the correct default WebSocket URL', () => {
    render(<RealtimeFeed channels={['task.*', 'contract.*']} />);
    expect(lastWebSocket?.url).toContain('ws://127.0.0.1:3000/v1/realtime');
  });

  it('includes channels as query param in WebSocket URL', () => {
    render(<RealtimeFeed channels={['task.*', 'contract.*']} />);
    expect(lastWebSocket?.url).toContain(encodeURIComponent('task.*,contract.*'));
  });

  it('uses wss:// when NEXT_PUBLIC_API_BASE_URL uses https://', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';
    render(<RealtimeFeed channels={['task.*']} />);
    expect(lastWebSocket?.url).toMatch(/^wss:\/\//);
  });

  it('uses ws:// when NEXT_PUBLIC_API_BASE_URL uses http://', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://api.example.com';
    render(<RealtimeFeed channels={['task.*']} />);
    expect(lastWebSocket?.url).toMatch(/^ws:\/\//);
  });

  it('displays an event when a valid WebSocket message is received', async () => {
    render(<RealtimeFeed channels={['task.*']} />);
    const feedEvent = {
      channel: 'task.created',
      event: {
        eventType: 'task.posted',
        entityId: 'task_abc',
        timestamp: '2026-03-02T00:00:00Z'
      }
    };

    await act(async () => {
      lastWebSocket?.onmessage?.({ data: JSON.stringify(feedEvent) } as MessageEvent);
    });

    expect(screen.getByText('task.created')).toBeInTheDocument();
    expect(screen.getByText('task.posted')).toBeInTheDocument();
    expect(screen.getByText('task_abc')).toBeInTheDocument();
  });

  it('removes "Waiting for events\u2026" once an event arrives', async () => {
    render(<RealtimeFeed channels={['task.*']} />);
    expect(screen.getByText('Waiting for events\u2026')).toBeInTheDocument();

    await act(async () => {
      lastWebSocket?.onmessage?.({
        data: JSON.stringify({
          channel: 'task.*',
          event: { eventType: 'task.created', entityId: 'task_1', timestamp: '' }
        })
      } as MessageEvent);
    });

    expect(screen.queryByText('Waiting for events\u2026')).toBeNull();
  });

  it('prepends new events (newest first)', async () => {
    render(<RealtimeFeed channels={['task.*']} />);

    await act(async () => {
      lastWebSocket?.onmessage?.({
        data: JSON.stringify({ channel: 'ch1', event: { eventType: 'first', entityId: 'e1', timestamp: '' } })
      } as MessageEvent);
    });

    await act(async () => {
      lastWebSocket?.onmessage?.({
        data: JSON.stringify({ channel: 'ch2', event: { eventType: 'second', entityId: 'e2', timestamp: '' } })
      } as MessageEvent);
    });

    const items = screen.getAllByText(/first|second/);
    expect(items[0]).toHaveTextContent('second');
    expect(items[1]).toHaveTextContent('first');
  });

  it('silently ignores invalid JSON messages', async () => {
    render(<RealtimeFeed channels={['task.*']} />);

    await act(async () => {
      lastWebSocket?.onmessage?.({ data: 'not valid json }{' } as MessageEvent);
    });

    expect(screen.getByText('Waiting for events\u2026')).toBeInTheDocument();
  });

  it('closes the WebSocket when the component unmounts', async () => {
    const { unmount } = render(<RealtimeFeed channels={['task.*']} />);
    const ws = lastWebSocket;
    unmount();
    expect(ws?.close).toHaveBeenCalledTimes(1);
  });

  it('caps displayed events at 25', async () => {
    render(<RealtimeFeed channels={['task.*']} />);

    await act(async () => {
      for (let i = 0; i < 30; i++) {
        lastWebSocket?.onmessage?.({
          data: JSON.stringify({
            channel: 'ch',
            event: { eventType: `event-${i}`, entityId: `e${i}`, timestamp: '' }
          })
        } as MessageEvent);
      }
    });

    // Should only display the newest 25 entityIds
    expect(screen.queryByText('e0')).toBeNull(); // oldest got trimmed
    expect(screen.getByText('e29')).toBeInTheDocument(); // newest visible
  });

  it('reconnects with a new WebSocket when channels prop changes', () => {
    const { rerender } = render(<RealtimeFeed channels={['task.*']} />);
    const first = lastWebSocket;

    rerender(<RealtimeFeed channels={['dispute.*']} />);
    const second = lastWebSocket;

    expect(second).not.toBe(first);
    expect(second?.url).toContain('dispute');
  });
});
