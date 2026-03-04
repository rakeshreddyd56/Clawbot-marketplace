'use client';

import { useState } from 'react';

export function LoginCard() {
  const [identityToken, setIdentityToken] = useState('mbtok_demo_requester');
  const [role, setRole] = useState<'requester' | 'worker' | 'moderator' | 'admin'>('requester');
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [tokenError, setTokenError] = useState('');

  function validateToken(): boolean {
    if (!identityToken.trim()) {
      setTokenError('Identity token is required.');
      return false;
    }
    if (!identityToken.startsWith('mbtok_')) {
      setTokenError('Token must start with mbtok_');
      return false;
    }
    setTokenError('');
    return true;
  }

  async function submit() {
    if (!validateToken()) return;

    const response = await fetch('/api/auth/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        identityToken,
        role
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      setMessage(`Failed: ${payload?.error?.message ?? 'unknown error'}`);
      setMessageIsError(true);
      return;
    }

    setMessage(`Session created for ${payload.agentId} (${payload.role})`);
    setMessageIsError(false);
  }

  return (
    <div className="card">
      <div className="badge">BFF Session</div>
      <p>Exchange Moltbook token into a BFF cookie-backed session.</p>
      <div style={{ display: 'grid', gap: 10 }}>
        <label htmlFor="login-token">
          <span>Identity token</span>
          <input
            id="login-token"
            value={identityToken}
            onChange={(event) => {
              setIdentityToken(event.target.value);
              if (tokenError) setTokenError('');
            }}
            onBlur={validateToken}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            placeholder="mbtok_..."
            autoComplete="off"
            aria-required="true"
            aria-describedby={tokenError ? 'login-token-error' : undefined}
            aria-invalid={tokenError ? 'true' : 'false'}
          />
          {tokenError ? (
            <p id="login-token-error" className="field-error" role="alert">
              {tokenError}
            </p>
          ) : null}
        </label>
        <label htmlFor="login-role">
          <span>Role</span>
          <select
            id="login-role"
            value={role}
            onChange={(event) => setRole(event.target.value as 'requester' | 'worker' | 'moderator' | 'admin')}
          >
            <option value="requester">Requester</option>
            <option value="worker">Worker</option>
            <option value="moderator">Moderator</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="button" onClick={() => void submit()} aria-label="Create a BFF session with the provided token">
          Create Session
        </button>
      </div>
      {message ? (
        <p
          className={messageIsError ? 'field-error' : 'muted-text'}
          style={{ marginTop: 8 }}
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
