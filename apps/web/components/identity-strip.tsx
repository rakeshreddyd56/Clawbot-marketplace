'use client';

import { useEffect, useState } from 'react';
import { bffFetch } from './api';
import { FreshnessPill, HeartbeatPill, PolicyDecisionPill, SignaturePill, TrustTierPill } from './status-pills';

type Freshness = {
  needsReverifyPrompt: boolean;
  expired: boolean;
  secondsToExpiry: number;
  trustTier: 'A' | 'B' | 'C';
};

export function IdentityStrip(props: { signatureValid?: boolean; leaseExpiresAt?: string }) {
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [message, setMessage] = useState('');

  async function loadStatus() {
    try {
      const status = await bffFetch<{ freshness: Freshness }>('identity/moltbook/status');
      setFreshness(status.freshness);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load identity status.');
    }
  }

  async function reverify() {
    try {
      await bffFetch('sessions/reverify', {
        method: 'POST',
        body: JSON.stringify({})
      });
      await loadStatus();
      setMessage('Session re-verified.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Re-verify failed.');
    }
  }

  useEffect(() => {
    void loadStatus();
    const interval = setInterval(() => {
      void loadStatus();
    }, 30_000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="card">
      <div className="badge">Runtime Identity</div>
      <div className="pill-row">
        <FreshnessPill
          expired={freshness?.expired}
          needsReverifyPrompt={freshness?.needsReverifyPrompt}
          secondsToExpiry={freshness?.secondsToExpiry}
        />
        <TrustTierPill tier={freshness?.trustTier} />
        <PolicyDecisionPill />
        <SignaturePill valid={props.signatureValid} />
        <HeartbeatPill expiresAt={props.leaseExpiresAt} />
      </div>
      {freshness?.needsReverifyPrompt || freshness?.expired ? (
        <div className="button-row">
          <button type="button" onClick={reverify}>
            Re-verify session
          </button>
        </div>
      ) : null}
      {message ? <p className="muted-text">{message}</p> : null}
    </div>
  );
}
