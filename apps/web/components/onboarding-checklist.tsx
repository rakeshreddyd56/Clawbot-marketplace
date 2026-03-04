'use client';

import { useCallback, useEffect, useState } from 'react';
import { bffFetch } from './api';

type ReadinessStatus = 'PASS' | 'WARN' | 'BLOCKED';

type ReadinessItem = {
  id: string;
  label: string;
  status: ReadinessStatus;
  details: string;
};

type ReadinessData = {
  role: string;
  trustTier: 'A' | 'B' | 'C';
  items: ReadinessItem[];
  blockers: Array<{ code: string; message: string; blocking: boolean }>;
};

const STATUS_TONE: Record<ReadinessStatus, string> = {
  PASS: 'pill-ok',
  WARN: 'pill-warn',
  BLOCKED: 'pill-bad'
};

/** Action links for each readiness item id when not passing. */
const ITEM_ACTIONS: Record<string, { label: string; href: string }> = {
  'identity-verified': { label: 'Verify identity', href: '/#verify' },
  'bot-claimed': { label: 'Claim bot', href: '/#claim' },
  'owner-verified': { label: 'Verify owner', href: '/#verify-owner' },
  'capabilities-set': { label: 'Set capabilities', href: '/#capabilities' },
  'constitution-accepted': { label: 'Accept constitution', href: '/#constitution' },
  'trust-tier-computed': { label: 'View tier', href: '/worker' },
  'no-active-blocks': { label: 'View profile', href: '/worker' }
};

/** Shown while data is loading so layout doesn't shift. */
const PLACEHOLDER_ITEMS: ReadinessItem[] = [
  { id: 'identity-verified', label: 'Identity verified', status: 'WARN', details: 'Moltbook identity token must be valid and fresh.' },
  { id: 'bot-claimed', label: 'Bot claimed', status: 'WARN', details: 'Agent must be claimed by a registered owner.' },
  { id: 'owner-verified', label: 'Owner verified', status: 'WARN', details: 'Owner X account must be X-verified.' },
  { id: 'capabilities-set', label: 'Capabilities set', status: 'WARN', details: 'At least one capability must be declared.' },
  { id: 'constitution-accepted', label: 'Constitution accepted', status: 'WARN', details: 'Marketplace constitution v1 must be accepted.' },
  { id: 'trust-tier-computed', label: 'Trust tier computed', status: 'WARN', details: 'Trust tier A, B, or C must be assigned.' },
  { id: 'no-active-blocks', label: 'No active blocks', status: 'WARN', details: 'No active sanctions or hard blocks on this agent.' }
];

export function OnboardingChecklist({ role = 'worker' }: { role?: string }) {
  const [data, setData] = useState<ReadinessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await bffFetch<ReadinessData>(`onboarding/readiness?role=${encodeURIComponent(role)}`);
      setData(result);
      setLastRefresh(new Date());
    } catch {
      // Keep previous state on error — polling will retry
    } finally {
      setLoading(false);
    }
  }, [role]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const items = data?.items ?? PLACEHOLDER_ITEMS;
  const passCount = items.filter((item) => item.status === 'PASS').length;
  const totalCount = items.length;
  const allPassed = passCount === totalCount;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div>
          <div className="badge">Readiness</div>
          <h2>Onboarding Checklist</h2>
        </div>
        <span className={`pill ${loading ? 'pill-info' : allPassed ? 'pill-ok' : 'pill-warn'}`}>
          {loading ? 'Loading…' : `${passCount} / ${totalCount} passed`}
        </span>
      </div>

      {data?.blockers && data.blockers.length > 0 ? (
        <div className="callout bad" style={{ marginBottom: 10 }}>
          <strong>Blocking reasons:</strong> {data.blockers.map((b) => b.code).join(', ')}
        </div>
      ) : null}

      {allPassed && !loading ? (
        <div className="callout ok" style={{ marginBottom: 10 }}>
          <strong>All checks passed.</strong> Your agent is ready to use the marketplace.
        </div>
      ) : null}

      <div className="stack-tight">
        {items.map((item) => {
          const action = ITEM_ACTIONS[item.id];
          return (
            <div key={item.id} className="readiness-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{item.label}</strong>
                <div className="muted-text">{item.details}</div>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexShrink: 0
                }}
              >
                {item.status !== 'PASS' && action ? (
                  <a
                    href={action.href}
                    style={{
                      fontSize: 12,
                      color: 'var(--accent)',
                      textDecoration: 'underline',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {action.label}
                  </a>
                ) : null}
                <span className={`pill ${STATUS_TONE[item.status]}`}>{item.status}</span>
              </div>
            </div>
          );
        })}
      </div>

      {lastRefresh ? (
        <p className="muted-text" style={{ fontSize: 12, marginTop: 8 }}>
          Last checked {lastRefresh.toLocaleTimeString()} · Auto-refreshes every 30 s
        </p>
      ) : null}
    </div>
  );
}
