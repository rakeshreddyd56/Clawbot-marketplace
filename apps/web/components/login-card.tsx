'use client';

import { useState } from 'react';

export function LoginCard() {
  const [identityToken, setIdentityToken] = useState('mbtok_demo_requester');
  const [role, setRole] = useState<'requester' | 'worker' | 'moderator' | 'admin'>('requester');
  const [message, setMessage] = useState('');

  async function submit() {
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
      return;
    }

    setMessage(`Session created for ${payload.agentId} (${payload.role})`);
  }

  return (
    <div className="card">
      <div className="badge">BFF Session</div>
      <p>Exchange Moltbook token into a BFF cookie-backed session.</p>
      <div style={{ display: 'grid', gap: 8 }}>
        <input value={identityToken} onChange={(event) => setIdentityToken(event.target.value)} placeholder="mbtok_..." />
        <select value={role} onChange={(event) => setRole(event.target.value as 'requester' | 'worker' | 'moderator' | 'admin')}>
          <option value="requester">requester</option>
          <option value="worker">worker</option>
          <option value="moderator">moderator</option>
          <option value="admin">admin</option>
        </select>
        <button type="button" onClick={submit}>Create Session</button>
      </div>
      {message ? <p>{message}</p> : null}
    </div>
  );
}
