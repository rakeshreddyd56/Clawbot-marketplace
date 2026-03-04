'use client';

import { useState } from 'react';
import { bffFetch } from './api';

type Props = {
  secondsToExpiry: number;
  onSuccess: () => void;
};

export function ReverifyBanner({ secondsToExpiry, onSuccess }: Props) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const minutesLeft = Math.ceil(secondsToExpiry / 60);

  async function submit() {
    if (!token.trim()) return;
    try {
      setLoading(true);
      setError('');
      await bffFetch('sessions/reverify', {
        method: 'POST',
        body: JSON.stringify({ identityToken: token.trim() })
      });
      setDismissed(true);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-verification failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
        background: 'var(--pill-warn-bg)',
        borderBottom: '2px solid rgba(141, 90, 15, 0.35)',
        padding: '10px 20px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12
      }}
    >
      <span style={{ color: 'var(--pill-warn)', fontWeight: 650, flexShrink: 0 }}>
        ⚠ Identity expires in ~{minutesLeft} min — re-verify to avoid interruption.
      </span>
      <label
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flex: 1,
          minWidth: 220,
          margin: 0
        }}
      >
        <span className="visually-hidden">Identity token</span>
        <input
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="mbtok_..."
          aria-label="Moltbook identity token for re-verification"
          style={{
            maxWidth: 300,
            borderColor: 'rgba(141, 90, 15, 0.45)',
            padding: '7px 10px'
          }}
        />
      </label>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={loading || !token.trim()}
        style={{ flexShrink: 0 }}
      >
        {loading ? 'Verifying…' : 'Re-verify'}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss re-verify banner"
        style={{
          background: 'transparent',
          border: '1px solid rgba(141, 90, 15, 0.4)',
          color: 'var(--pill-warn)',
          borderRadius: 999,
          padding: '7px 12px',
          flexShrink: 0
        }}
      >
        Dismiss
      </button>
      {error ? (
        <span style={{ color: 'var(--pill-bad)', fontSize: 13, width: '100%' }}>{error}</span>
      ) : null}
    </div>
  );
}
