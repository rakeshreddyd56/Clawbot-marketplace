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

export function RealtimeFeed({ channels }: { channels: string[] }) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const channelQuery = useMemo(() => channels.join(','), [channels]);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000';
    const wsUrl = base.replace('http://', 'ws://').replace('https://', 'wss://');
    const socket = new WebSocket(`${wsUrl}/v1/realtime?channels=${encodeURIComponent(channelQuery)}`);

    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data) as FeedEvent;
        setEvents((current) => [parsed, ...current].slice(0, 25));
      } catch {
        return;
      }
    };

    return () => {
      socket.close();
    };
  }, [channelQuery]);

  return (
    <div className="card">
      <div className="badge">Realtime</div>
      <div className="feed">
        {events.length === 0 ? <div>No events yet.</div> : null}
        {events.map((item, idx) => (
          <div key={`${item.event.entityId}-${idx}`} style={{ marginBottom: 8 }}>
            <strong>{item.channel}</strong>
            <div>{item.event.eventType}</div>
            <small>{item.event.entityId}</small>
          </div>
        ))}
      </div>
    </div>
  );
}
