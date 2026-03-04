'use client';

import { useEffect, useMemo, useState } from 'react';

type FeedEvent = {
  channel: string;
  event: {
    eventType: string;
    entityId: string;
    timestamp: string;
  };
};

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

const STATUS_PILL: Record<ConnectionStatus, string> = {
  connected: 'pill-ok',
  reconnecting: 'pill-warn',
  disconnected: 'pill-bad'
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected'
};

/**
 * Subscribes to the Clawbot realtime WebSocket and renders an event feed.
 *
 * Reconnection strategy: exponential backoff starting at 1 s, doubling each
 * attempt (1 → 2 → 4 → 8 → 16 → 30 s max). Event history is preserved
 * across reconnections so the feed doesn't blank out on transient failures.
 *
 * Pauses reconnection attempts while the tab is hidden (Page Visibility API)
 * to avoid unnecessary background connections.
 */
export function RealtimeFeed({ channels }: { channels: string[] }) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [retryCount, setRetryCount] = useState(0);
  const channelQuery = useMemo(() => channels.join(','), [channels]);

  useEffect(() => {
    let destroyed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let currentSocket: WebSocket | null = null;
    let paused = false;

    function connect() {
      if (destroyed || paused) return;

      const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000';
      const wsUrl = base.replace('http://', 'ws://').replace('https://', 'wss://');
      const socket = new WebSocket(`${wsUrl}/v1/realtime?channels=${encodeURIComponent(channelQuery)}`);
      currentSocket = socket;

      socket.onopen = () => {
        if (destroyed) {
          socket.close();
          return;
        }
        attempt = 0;
        setRetryCount(0);
        setStatus('connected');
      };

      socket.onmessage = (message) => {
        try {
          const parsed = JSON.parse(message.data) as FeedEvent;
          setEvents((current) => [parsed, ...current].slice(0, 25));
        } catch {
          // Ignore malformed frames
        }
      };

      socket.onclose = () => {
        if (destroyed || paused) return;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        attempt++;
        setRetryCount(attempt);
        setStatus('reconnecting');
        retryTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    }

    function pause() {
      paused = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (currentSocket) {
        currentSocket.close();
        currentSocket = null;
      }
      setStatus('disconnected');
    }

    function resume() {
      paused = false;
      attempt = 0;
      connect();
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        pause();
      } else {
        resume();
      }
    }

    if (!document.hidden) {
      connect();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      destroyed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (retryTimer) clearTimeout(retryTimer);
      if (currentSocket) currentSocket.close();
    };
  }, [channelQuery]);

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="badge">Realtime</div>
        <span
          className={`pill ${STATUS_PILL[status]}`}
          role="status"
          aria-label={`WebSocket: ${STATUS_LABEL[status]}${retryCount > 0 && status === 'reconnecting' ? `, attempt ${retryCount}` : ''}`}
        >
          {STATUS_LABEL[status]}
          {retryCount > 0 && status === 'reconnecting' ? ` (attempt ${retryCount})` : ''}
        </span>
      </div>
      <div
        className="feed"
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Realtime marketplace events"
      >
        {events.length === 0 ? (
          <p className="muted-text" style={{ margin: 0 }}>
            Waiting for events…
          </p>
        ) : null}
        {events.map((item, idx) => (
          <div key={`${item.event.entityId}-${idx}`} className="feed-event">
            <strong>{item.channel}</strong>
            <div>{item.event.eventType}</div>
            <small className="muted-text">{item.event.entityId}</small>
          </div>
        ))}
      </div>
    </div>
  );
}
