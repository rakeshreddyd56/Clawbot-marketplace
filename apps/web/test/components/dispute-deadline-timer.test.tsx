import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DisputeDeadlineTimer, useDeadlineStatus } from '../../components/dispute-deadline-timer';
import type { DeadlineStatus } from '../../components/dispute-deadline-timer';

// Helper to render useDeadlineStatus hook
function HookWrapper({ deadlineAt, respondedAt }: { deadlineAt: string; respondedAt?: string }) {
  const status = useDeadlineStatus(deadlineAt, respondedAt);
  return <span data-testid="hook-status">{status}</span>;
}

describe('DisputeDeadlineTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Status thresholds ──────────────────────────────────────────────────────

  describe('status thresholds', () => {
    it('shows "safe" status when >24h remaining', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} />);
      const timer = screen.getByTestId('deadline-timer');
      expect(timer).toHaveClass('deadline-safe');
      expect(screen.getByText('Appeal window open')).toBeInTheDocument();
    });

    it('shows "warning" status when 6-24h remaining', () => {
      const deadline = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12h
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} />);
      const timer = screen.getByTestId('deadline-timer');
      expect(timer).toHaveClass('deadline-warning');
      expect(screen.getByText('Deadline approaching')).toBeInTheDocument();
    });

    it('shows "critical" status when <6h remaining', () => {
      const deadline = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // 3h
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} />);
      const timer = screen.getByTestId('deadline-timer');
      expect(timer).toHaveClass('deadline-critical');
      expect(screen.getByText('Deadline imminent')).toBeInTheDocument();
    });

    it('shows "expired" status when deadline has passed', () => {
      const deadline = new Date(Date.now() - 1000).toISOString(); // 1s ago
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} />);
      const timer = screen.getByTestId('deadline-timer');
      expect(timer).toHaveClass('deadline-expired');
      expect(screen.getByText('Auto-ruling applied')).toBeInTheDocument();
      expect(screen.getByTestId('deadline-countdown')).toHaveTextContent('EXPIRED');
    });
  });

  // ─── Variant: response ────────────────────────────────────────────────────

  describe('variant="response"', () => {
    it('shows response-specific labels for safe status', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} variant="response" />);
      expect(screen.getByText('Awaiting response')).toBeInTheDocument();
    });

    it('shows response-specific labels for warning status', () => {
      const deadline = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} variant="response" />);
      expect(screen.getByText('Response deadline approaching')).toBeInTheDocument();
    });

    it('shows response-specific labels for critical status', () => {
      const deadline = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} variant="response" />);
      expect(screen.getByText('Response deadline imminent')).toBeInTheDocument();
    });

    it('shows response-specific expired label', () => {
      const deadline = new Date(Date.now() - 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} variant="response" />);
      expect(screen.getByText('No response — auto-ruling applied')).toBeInTheDocument();
      expect(screen.getByText(/72-hour response window has closed/)).toBeInTheDocument();
    });
  });

  // ─── respondedAt prop ─────────────────────────────────────────────────────

  describe('respondedAt (response received)', () => {
    it('shows "responded" state when respondedAt is provided', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const responded = new Date(Date.now() - 3600000).toISOString();
      render(
        <DisputeDeadlineTimer
          appealDeadlineAt={deadline}
          variant="response"
          respondedAt={responded}
        />
      );
      const timer = screen.getByTestId('deadline-timer');
      expect(timer).toHaveClass('deadline-responded');
      expect(screen.getByTestId('deadline-countdown')).toHaveTextContent('RESPONDED');
      expect(screen.getByText('Response received')).toBeInTheDocument();
      expect(screen.getByText(/Target party responded/)).toBeInTheDocument();
    });

    it('shows "Appeal filed" for appeal variant when respondedAt is set', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const responded = new Date().toISOString();
      render(
        <DisputeDeadlineTimer
          appealDeadlineAt={deadline}
          variant="appeal"
          respondedAt={responded}
        />
      );
      expect(screen.getByText('Appeal filed')).toBeInTheDocument();
    });

    it('does not call onExpired when respondedAt is set', () => {
      const onExpired = vi.fn();
      const deadline = new Date(Date.now() - 1000).toISOString(); // expired
      const responded = new Date(Date.now() - 3600000).toISOString();
      render(
        <DisputeDeadlineTimer
          appealDeadlineAt={deadline}
          respondedAt={responded}
          onExpired={onExpired}
        />
      );
      expect(onExpired).not.toHaveBeenCalled();
    });
  });

  // ─── Compact mode ─────────────────────────────────────────────────────────

  describe('compact mode', () => {
    it('renders compact timer with pill class', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} compact />);
      const timer = screen.getByTestId('deadline-timer-compact');
      expect(timer).toHaveClass('pill');
      expect(timer).toHaveClass('pill-ok');
      expect(timer).toHaveClass('deadline-pill');
    });

    it('shows EXPIRED in compact mode when deadline passed', () => {
      const deadline = new Date(Date.now() - 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} compact />);
      const timer = screen.getByTestId('deadline-timer-compact');
      expect(timer).toHaveTextContent('EXPIRED');
      expect(timer).toHaveClass('pill-bad');
    });

    it('shows RESPONDED in compact mode when respondedAt is set', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const responded = new Date().toISOString();
      render(
        <DisputeDeadlineTimer
          appealDeadlineAt={deadline}
          compact
          respondedAt={responded}
        />
      );
      const timer = screen.getByTestId('deadline-timer-compact');
      expect(timer).toHaveTextContent('RESPONDED');
      expect(timer).toHaveClass('pill-ok');
    });
  });

  // ─── Countdown format ─────────────────────────────────────────────────────

  describe('countdown formatting', () => {
    it('pads hours, minutes, seconds with leading zeros', () => {
      const deadline = new Date(Date.now() + (2 * 3600 + 5 * 60 + 9) * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} />);
      expect(screen.getByTestId('deadline-countdown')).toHaveTextContent('02:05:09');
    });

    it('shows correct time for full 72h', () => {
      const deadline = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} />);
      // Should show 72:00:00 or 71:59:59 depending on render timing
      expect(screen.getByTestId('deadline-countdown')).toHaveTextContent(/7[12]:\d\d:\d\d/);
    });
  });

  // ─── onExpired callback ───────────────────────────────────────────────────

  describe('onExpired callback', () => {
    it('calls onExpired immediately when deadline has already passed', () => {
      const onExpired = vi.fn();
      const deadline = new Date(Date.now() - 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} onExpired={onExpired} />);
      expect(onExpired).toHaveBeenCalledTimes(1);
    });

    it('calls onExpired when timer reaches zero', () => {
      const onExpired = vi.fn();
      const deadline = new Date(Date.now() + 2000).toISOString(); // 2s from now
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} onExpired={onExpired} />);
      expect(onExpired).not.toHaveBeenCalled();

      // Advance past deadline
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(onExpired).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Accessibility ────────────────────────────────────────────────────────

  describe('accessibility', () => {
    it('has role="timer" on full timer', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} />);
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });

    it('has role="timer" on compact timer', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} compact />);
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });

    it('has aria-live="polite" for screen reader updates', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} />);
      expect(screen.getByRole('timer')).toHaveAttribute('aria-live', 'polite');
    });

    it('includes deadline type in aria-label for response variant', () => {
      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      render(<DisputeDeadlineTimer appealDeadlineAt={deadline} variant="response" />);
      expect(screen.getByRole('timer')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('Response deadline')
      );
    });
  });
});

// ─── useDeadlineStatus hook ───────────────────────────────────────────────────

describe('useDeadlineStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "safe" for >24h deadline', () => {
    const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    render(<HookWrapper deadlineAt={deadline} />);
    expect(screen.getByTestId('hook-status')).toHaveTextContent('safe');
  });

  it('returns "expired" for past deadline', () => {
    const deadline = new Date(Date.now() - 1000).toISOString();
    render(<HookWrapper deadlineAt={deadline} />);
    expect(screen.getByTestId('hook-status')).toHaveTextContent('expired');
  });

  it('returns "responded" when respondedAt is provided', () => {
    const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const responded = new Date().toISOString();
    render(<HookWrapper deadlineAt={deadline} respondedAt={responded} />);
    expect(screen.getByTestId('hook-status')).toHaveTextContent('responded');
  });

  it('returns "warning" for 6-24h deadline', () => {
    const deadline = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    render(<HookWrapper deadlineAt={deadline} />);
    expect(screen.getByTestId('hook-status')).toHaveTextContent('warning');
  });

  it('returns "critical" for <6h deadline', () => {
    const deadline = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    render(<HookWrapper deadlineAt={deadline} />);
    expect(screen.getByTestId('hook-status')).toHaveTextContent('critical');
  });
});
