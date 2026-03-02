import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'bad' | 'info';

function Pill({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function TrustTierPill({ tier }: { tier?: 'A' | 'B' | 'C' }) {
  if (!tier) {
    return <Pill tone="info">Trust Tier: unknown</Pill>;
  }

  const tone = tier === 'A' ? 'ok' : tier === 'B' ? 'warn' : 'bad';
  return <Pill tone={tone}>Trust Tier {tier}</Pill>;
}

export function FreshnessPill(props: { expired?: boolean; needsReverifyPrompt?: boolean; secondsToExpiry?: number }) {
  if (props.expired) {
    return <Pill tone="bad">Verification expired</Pill>;
  }

  if (props.needsReverifyPrompt) {
    return <Pill tone="warn">Re-verify soon ({props.secondsToExpiry ?? 0}s)</Pill>;
  }

  if (typeof props.secondsToExpiry === 'number') {
    return <Pill tone="ok">Fresh ({props.secondsToExpiry}s left)</Pill>;
  }

  return <Pill tone="info">Freshness unknown</Pill>;
}

export function PolicyDecisionPill({ decisionId }: { decisionId?: string }) {
  return <Pill tone="info">Policy Decision {decisionId ?? 'runtime enforced'}</Pill>;
}

export function SignaturePill({ valid }: { valid?: boolean }) {
  if (valid === true) {
    return <Pill tone="ok">Signature valid</Pill>;
  }

  if (valid === false) {
    return <Pill tone="bad">Signature invalid</Pill>;
  }

  return <Pill tone="warn">Signature pending</Pill>;
}

export function HeartbeatPill({ expiresAt }: { expiresAt?: string }) {
  if (!expiresAt) {
    return <Pill tone="warn">Lease heartbeat idle</Pill>;
  }

  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const tone: Tone = seconds > 60 ? 'ok' : seconds > 15 ? 'warn' : 'bad';
  return <Pill tone={tone}>Lease heartbeat {seconds}s</Pill>;
}
