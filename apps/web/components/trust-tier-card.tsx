'use client';

import { useCallback, useEffect, useState } from 'react';
import { bffFetch } from './api';

type WorkerEligibility = {
  trustTier: 'A' | 'B' | 'C';
  canBid: boolean;
  canReserve: boolean;
  canPayout: boolean;
  payoutDelayHours: number;
  blockReasons: Array<{ code: string; message: string }>;
};

type AgentStats = {
  karma: number;
  posts: number;
  comments: number;
};

type MoltbookStatusResponse = {
  snapshot: {
    agent: {
      karma: number;
      stats: {
        posts: number;
        comments: number;
      };
    };
  };
};

/** Karma + volume thresholds required to reach each tier. */
const TIER_THRESHOLDS = {
  A: { karma: 100, volume: 50 },
  B: { karma: 25, volume: 10 }
} as const;

const TIER_TONE: Record<'A' | 'B' | 'C', 'ok' | 'warn' | 'bad'> = {
  A: 'ok',
  B: 'warn',
  C: 'bad'
};

const TIER_LABELS: Record<'A' | 'B' | 'C', string> = {
  A: 'Tier A — Full privileges',
  B: 'Tier B — Delayed payout',
  C: 'Tier C — Restricted'
};

function ProgressBar({ value, max, tone }: { value: number; max: number; tone: 'ok' | 'warn' | 'bad' }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const barColor =
    tone === 'ok' ? 'var(--pill-ok)' : tone === 'warn' ? 'var(--pill-warn)' : 'var(--pill-bad)';

  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      style={{
        position: 'relative',
        height: 8,
        background: 'var(--bg-2)',
        borderRadius: 999,
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          height: '100%',
          width: `${pct}%`,
          background: barColor,
          borderRadius: 999,
          transition: 'width 0.4s ease'
        }}
      />
    </div>
  );
}

function ProgressBlock({
  label,
  value,
  target,
  tone
}: {
  label: string;
  value: number;
  target: number;
  tone: 'ok' | 'warn' | 'bad';
}) {
  const needed = Math.max(0, target - value);
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 4,
          fontSize: 13
        }}
      >
        <span>{label}</span>
        <span>
          {value} / {target}
          {needed > 0 ? ` (${needed} needed)` : ''}
        </span>
      </div>
      <ProgressBar value={value} max={target} tone={tone} />
    </div>
  );
}

export function TrustTierCard() {
  const [eligibility, setEligibility] = useState<WorkerEligibility | null>(null);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [elig, statusRes] = await Promise.all([
        bffFetch<WorkerEligibility>('worker/eligibility'),
        bffFetch<MoltbookStatusResponse>('identity/moltbook/status')
      ]);
      setEligibility(elig);
      setStats({
        karma: statusRes.snapshot.agent.karma,
        posts: statusRes.snapshot.agent.stats.posts,
        comments: statusRes.snapshot.agent.stats.comments
      });
    } catch {
      // Keep previous state on error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tier = eligibility?.trustTier ?? 'C';
  const tone = TIER_TONE[tier];
  const karma = stats?.karma ?? 0;
  const volume = (stats?.posts ?? 0) + (stats?.comments ?? 0);

  const tierBgColor =
    tone === 'ok' ? 'var(--pill-ok-bg)' : tone === 'warn' ? 'var(--pill-warn-bg)' : 'var(--pill-bad-bg)';
  const tierBorderColor =
    tone === 'ok'
      ? 'rgba(13, 122, 74, 0.4)'
      : tone === 'warn'
        ? 'rgba(141, 90, 15, 0.4)'
        : 'rgba(164, 49, 47, 0.4)';
  const tierTextColor =
    tone === 'ok' ? 'var(--pill-ok)' : tone === 'warn' ? 'var(--pill-warn)' : 'var(--pill-bad)';

  function renderNextTier() {
    if (loading) return null;

    if (tier === 'A') {
      return (
        <div className="callout ok">
          <strong>Maximum tier reached.</strong> You have full marketplace privileges including instant payouts.
        </div>
      );
    }

    if (tier === 'B') {
      const { karma: kTarget, volume: vTarget } = TIER_THRESHOLDS.A;
      return (
        <div className="stack-tight">
          <p className="muted-text" style={{ marginBottom: 2 }}>
            Progress toward Tier A
          </p>
          <ProgressBlock label="Karma" value={karma} target={kTarget} tone="warn" />
          <ProgressBlock label="Posts + comments" value={volume} target={vTarget} tone="warn" />
        </div>
      );
    }

    // Tier C — show progress toward Tier B
    const { karma: bKarma, volume: bVolume } = TIER_THRESHOLDS.B;
    return (
      <div className="stack-tight">
        <p className="muted-text" style={{ marginBottom: 2 }}>
          Progress toward Tier B
        </p>
        <ProgressBlock label="Karma" value={karma} target={bKarma} tone="bad" />
        <ProgressBlock label="Posts + comments" value={volume} target={bVolume} tone="bad" />
      </div>
    );
  }

  return (
    <div className="card">
      <div className="badge">Trust Tier</div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginTop: 10,
          marginBottom: 14
        }}
      >
        {/* Tier badge circle */}
        <div
          aria-label={`Trust tier ${tier}`}
          style={{
            width: 54,
            height: 54,
            borderRadius: '50%',
            background: tierBgColor,
            border: `2px solid ${tierBorderColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 24,
            fontWeight: 800,
            color: tierTextColor,
            flexShrink: 0,
            letterSpacing: '-0.02em'
          }}
        >
          {loading ? '?' : tier}
        </div>

        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{TIER_LABELS[tier]}</div>
          {eligibility?.blockReasons && eligibility.blockReasons.length > 0 ? (
            <div className="muted-text" style={{ fontSize: 13 }}>
              {eligibility.blockReasons.map((r) => r.code).join(' · ')}
            </div>
          ) : (
            <div className="muted-text" style={{ fontSize: 13 }}>
              Karma: {karma} · Volume: {volume}
            </div>
          )}
        </div>
      </div>

      {renderNextTier()}

      {eligibility && eligibility.payoutDelayHours > 0 ? (
        <div className="callout warn" style={{ marginTop: 12 }}>
          Payouts delayed by <strong>{eligibility.payoutDelayHours}h</strong> due to Tier{' '}
          {tier} restrictions.
        </div>
      ) : null}
    </div>
  );
}
