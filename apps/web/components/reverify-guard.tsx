'use client';

import { useCallback, useEffect, useState } from 'react';
import { bffFetch } from './api';
import { ReverifyBanner } from './reverify-banner';
import { ReverifyModal } from './reverify-modal';

type Freshness = {
  needsReverifyPrompt: boolean;
  expired: boolean;
  secondsToExpiry: number;
};

/**
 * Polls /api/bff/identity/moltbook/status every 30 seconds.
 * Shows an amber banner when identity is expiring soon (needsReverifyPrompt).
 * Shows a blocking modal overlay when identity has expired.
 * Silently skips polling errors (user may not have a session yet on onboarding).
 */
export function ReverifyGuard() {
  const [freshness, setFreshness] = useState<Freshness | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const status = await bffFetch<{ freshness: Freshness }>('identity/moltbook/status');
      setFreshness(status.freshness);
    } catch {
      // No active session — silently ignore (onboarding page, unauthenticated state)
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const interval = setInterval(() => void loadStatus(), 30_000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  if (!freshness) return null;

  if (freshness.expired) {
    return <ReverifyModal onSuccess={() => void loadStatus()} />;
  }

  if (freshness.needsReverifyPrompt) {
    return (
      <ReverifyBanner
        secondsToExpiry={freshness.secondsToExpiry}
        onSuccess={() => void loadStatus()}
      />
    );
  }

  return null;
}
