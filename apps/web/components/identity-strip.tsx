'use client';

import { useCallback, useEffect, useState } from 'react';
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

  const loadStatus = useCallback(async () => {
    try {
      const status = await bffFetch<{ freshness: Freshness }>('identity/moltbook/status');
      setFreshness(status.freshness);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load identity status.');
    }
  }, []);

  const reverify = useCallback(async () => {
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
  }, [loadStatus]);

  useEffect(() => {
    void loadStatus();

    let interval: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      interval = setInterval(() => {
        void loadStatus();
      }, 30_000);
    }

    function stopPolling() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        stopPolling();
      } else {
        void loadStatus();
        startPolling();
      }
    }

    startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadStatus]);

  const needsAction = freshness?.needsReverifyPrompt || freshness?.expired;

  return (
    <div className="card" aria-label="Runtime identity status">
      <div className="badge">Runtime Identity</div>
      <div className="pill-row" aria-label="Identity status indicators">
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
      {needsAction ? (
        <div className="button-row">
          <button type="button" onClick={() => void reverify()} aria-label="Re-verify your session to refresh identity freshness">
            Re-verify session
          </button>
        </div>
      ) : null}
      {message ? (
        <p className="muted-text" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
