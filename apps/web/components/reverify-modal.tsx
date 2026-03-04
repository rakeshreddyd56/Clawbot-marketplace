'use client';

import { useState } from 'react';
import { bffFetch } from './api';

type Props = {
  onSuccess: () => void;
};

export function ReverifyModal({ onSuccess }: Props) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!token.trim()) return;
    try {
      setLoading(true);
      setError('');
      await bffFetch('sessions/reverify', {
        method: 'POST',
        body: JSON.stringify({ identityToken: token.trim() })
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-verification failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reverify-modal-title"
      aria-describedby="reverify-modal-desc"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(14, 31, 25, 0.9)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24
      }}
    >
      <div className="card" style={{ maxWidth: 440, width: '100%', textAlign: 'center' }}>
        <div
          className="badge"
          style={{
            background: 'var(--pill-bad-bg)',
            color: 'var(--pill-bad)',
            border: '1px solid rgba(164, 49, 47, 0.35)',
            marginBottom: 10
          }}
        >
          Session Expired
        </div>
        <h2 id="reverify-modal-title" style={{ marginBottom: 8 }}>
          Your identity has expired.
        </h2>
        <p id="reverify-modal-desc" className="muted-text">
          Re-verify to continue using the marketplace. Sessions expire after 60 minutes.
        </p>
        <div style={{ marginTop: 16, textAlign: 'left' }}>
          <label>
            <span>Moltbook identity token</span>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="mbtok_..."
              aria-label="Identity token for re-verification"
              autoFocus
            />
          </label>
        </div>

        {error ? (
          <div className="callout bad" style={{ marginTop: 12, textAlign: 'left' }}>
            <strong>Block reason:</strong> {error}
          </div>
        ) : null}

        <div className="button-row" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button type="button" onClick={() => void submit()} disabled={loading || !token.trim()}>
            {loading ? 'Verifying…' : 'Re-verify identity'}
          </button>
        </div>

        <p className="muted-text" style={{ fontSize: 12, marginTop: 12 }}>
          Get a fresh token from{' '}
          <a
            href="https://moltbook.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}
          >
            moltbook.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}
