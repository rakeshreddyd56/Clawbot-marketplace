import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  TrustTierPill,
  FreshnessPill,
  PolicyDecisionPill,
  SignaturePill,
  HeartbeatPill
} from '../../components/status-pills';

// ─── TrustTierPill ────────────────────────────────────────────────────────────
describe('TrustTierPill', () => {
  it('renders "Trust Tier: unknown" when tier is undefined', () => {
    render(<TrustTierPill />);
    expect(screen.getByText('Trust Tier: unknown')).toBeInTheDocument();
    expect(screen.getByText('Trust Tier: unknown')).toHaveClass('pill-info');
  });

  it('renders tier A with ok tone', () => {
    render(<TrustTierPill tier="A" />);
    const pill = screen.getByText('Trust Tier A');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-ok');
  });

  it('renders tier B with warn tone', () => {
    render(<TrustTierPill tier="B" />);
    const pill = screen.getByText('Trust Tier B');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-warn');
  });

  it('renders tier C with bad tone', () => {
    render(<TrustTierPill tier="C" />);
    const pill = screen.getByText('Trust Tier C');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-bad');
  });
});

// ─── FreshnessPill ───────────────────────────────────────────────────────────
describe('FreshnessPill', () => {
  it('renders expired state with bad tone', () => {
    render(<FreshnessPill expired={true} />);
    const pill = screen.getByText('Verification expired');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-bad');
  });

  it('expired takes priority over needsReverifyPrompt', () => {
    render(<FreshnessPill expired={true} needsReverifyPrompt={true} secondsToExpiry={30} />);
    expect(screen.getByText('Verification expired')).toBeInTheDocument();
  });

  it('renders needsReverifyPrompt with warn tone and seconds', () => {
    render(<FreshnessPill expired={false} needsReverifyPrompt={true} secondsToExpiry={45} />);
    const pill = screen.getByText('Re-verify soon (45s)');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-warn');
  });

  it('renders re-verify prompt with 0 when secondsToExpiry is undefined', () => {
    render(<FreshnessPill expired={false} needsReverifyPrompt={true} />);
    expect(screen.getByText('Re-verify soon (0s)')).toBeInTheDocument();
  });

  it('renders fresh state with ok tone when only secondsToExpiry is provided', () => {
    render(<FreshnessPill secondsToExpiry={600} />);
    const pill = screen.getByText('Fresh (600s left)');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-ok');
  });

  it('renders 0 seconds left as fresh', () => {
    render(<FreshnessPill secondsToExpiry={0} />);
    expect(screen.getByText('Fresh (0s left)')).toBeInTheDocument();
  });

  it('renders unknown freshness when all props are undefined', () => {
    render(<FreshnessPill />);
    const pill = screen.getByText('Freshness unknown');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-info');
  });
});

// ─── PolicyDecisionPill ───────────────────────────────────────────────────────
describe('PolicyDecisionPill', () => {
  it('renders default "runtime enforced" when no decisionId', () => {
    render(<PolicyDecisionPill />);
    const pill = screen.getByText('Policy Decision runtime enforced');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-info');
  });

  it('renders provided decisionId', () => {
    render(<PolicyDecisionPill decisionId="dec_abc123" />);
    expect(screen.getByText('Policy Decision dec_abc123')).toBeInTheDocument();
  });
});

// ─── SignaturePill ────────────────────────────────────────────────────────────
describe('SignaturePill', () => {
  it('renders "Signature valid" with ok tone when valid=true', () => {
    render(<SignaturePill valid={true} />);
    const pill = screen.getByText('Signature valid');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-ok');
  });

  it('renders "Signature invalid" with bad tone when valid=false', () => {
    render(<SignaturePill valid={false} />);
    const pill = screen.getByText('Signature invalid');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-bad');
  });

  it('renders "Signature pending" with warn tone when valid is undefined', () => {
    render(<SignaturePill />);
    const pill = screen.getByText('Signature pending');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-warn');
  });
});

// ─── HeartbeatPill ────────────────────────────────────────────────────────────
describe('HeartbeatPill', () => {
  const realDateNow = Date.now;

  beforeEach(() => {
    // Fix Date.now to 2026-03-02T00:00:00Z
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-02T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders idle state when expiresAt is undefined', () => {
    render(<HeartbeatPill />);
    const pill = screen.getByText('Lease heartbeat idle');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-warn');
  });

  it('renders ok tone when lease expires in > 60 seconds', () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString(); // 120s from now
    render(<HeartbeatPill expiresAt={expiresAt} />);
    const pill = screen.getByText('Lease heartbeat 120s');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-ok');
  });

  it('renders warn tone when lease expires in 15–60 seconds', () => {
    const expiresAt = new Date(Date.now() + 30_000).toISOString(); // 30s from now
    render(<HeartbeatPill expiresAt={expiresAt} />);
    const pill = screen.getByText('Lease heartbeat 30s');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-warn');
  });

  it('renders bad tone when lease expires in < 15 seconds', () => {
    const expiresAt = new Date(Date.now() + 10_000).toISOString(); // 10s from now
    render(<HeartbeatPill expiresAt={expiresAt} />);
    const pill = screen.getByText('Lease heartbeat 10s');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('pill-bad');
  });

  it('clamps to 0 seconds when lease is already expired', () => {
    const expiresAt = new Date(Date.now() - 5_000).toISOString(); // 5s ago
    render(<HeartbeatPill expiresAt={expiresAt} />);
    expect(screen.getByText('Lease heartbeat 0s')).toBeInTheDocument();
    expect(screen.getByText('Lease heartbeat 0s')).toHaveClass('pill-bad');
  });

  it('renders exactly 60s boundary as warn (> 60 = ok, 60 = warn)', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString(); // exactly 60s
    render(<HeartbeatPill expiresAt={expiresAt} />);
    // 60s → seconds > 60 is false → seconds > 15 is true → warn
    expect(screen.getByText('Lease heartbeat 60s')).toHaveClass('pill-warn');
  });
});
