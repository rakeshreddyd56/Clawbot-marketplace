'use client';

import { useEffect, useState } from 'react';

export type DeadlineStatus = 'safe' | 'warning' | 'critical' | 'expired' | 'responded';

type DeadlineVariant = 'appeal' | 'response';

type Props = {
  /** ISO 8601 appeal deadline timestamp */
  appealDeadlineAt: string;
  /** Compact mode shows only the countdown, no label */
  compact?: boolean;
  /** Called when the deadline expires */
  onExpired?: () => void;
  /** Deadline variant: 'appeal' (default) or 'response' for 72h response deadline */
  variant?: DeadlineVariant;
  /** ISO 8601 timestamp when the target party responded (clears the countdown) */
  respondedAt?: string;
};

function computeRemaining(deadlineMs: number): {
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
  status: DeadlineStatus;
} {
  const now = Date.now();
  const totalMs = deadlineMs - now;

  if (totalMs <= 0) {
    return { hours: 0, minutes: 0, seconds: 0, totalMs: 0, status: 'expired' };
  }

  const totalSec = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  let status: DeadlineStatus = 'safe';
  if (hours < 6) status = 'critical';
  else if (hours < 24) status = 'warning';

  return { hours, minutes, seconds, totalMs, status };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function statusToPillClass(status: DeadlineStatus): string {
  switch (status) {
    case 'safe':
      return 'pill-ok';
    case 'warning':
      return 'pill-warn';
    case 'responded':
      return 'pill-ok';
    case 'critical':
    case 'expired':
      return 'pill-bad';
  }
}

function statusLabel(status: DeadlineStatus, variant: DeadlineVariant = 'appeal'): string {
  if (status === 'responded') {
    return variant === 'response' ? 'Response received' : 'Appeal filed';
  }
  if (variant === 'response') {
    switch (status) {
      case 'safe':
        return 'Awaiting response';
      case 'warning':
        return 'Response deadline approaching';
      case 'critical':
        return 'Response deadline imminent';
      case 'expired':
        return 'No response — auto-ruling applied';
    }
  }
  switch (status) {
    case 'safe':
      return 'Appeal window open';
    case 'warning':
      return 'Deadline approaching';
    case 'critical':
      return 'Deadline imminent';
    case 'expired':
      return 'Auto-ruling applied';
  }
}

function variantLabel(variant: DeadlineVariant): string {
  return variant === 'response' ? 'Response deadline' : 'Appeal deadline';
}

/**
 * Live countdown timer for the 72-hour dispute response/appeal deadline.
 * Displays remaining time with color-coded urgency:
 * - Green (>24h): Safe — window open
 * - Amber (6-24h): Warning — deadline approaching
 * - Red (<6h): Critical — deadline imminent
 * - Red (0): Expired — auto-ruling applied
 * - Green (responded): Target party responded in time
 *
 * Supports two variants:
 * - 'appeal' (default): 72h appeal window after auto-decision
 * - 'response': 72h response deadline for the target party
 *
 * When `respondedAt` is set, the timer shows a "responded" state
 * instead of counting down, indicating the deadline was met.
 */
export function DisputeDeadlineTimer({
  appealDeadlineAt,
  compact = false,
  onExpired,
  variant = 'appeal',
  respondedAt
}: Props) {
  const deadlineMs = new Date(appealDeadlineAt).getTime();
  const hasResponded = Boolean(respondedAt);
  const [remaining, setRemaining] = useState(() =>
    hasResponded
      ? { hours: 0, minutes: 0, seconds: 0, totalMs: 0, status: 'responded' as DeadlineStatus }
      : computeRemaining(deadlineMs)
  );

  useEffect(() => {
    // If already responded, no need for a timer
    if (hasResponded) return;

    if (remaining.totalMs <= 0) {
      onExpired?.();
      return;
    }

    let firedExpired = false;
    const interval = setInterval(() => {
      const next = computeRemaining(deadlineMs);
      setRemaining(next);
      if (next.totalMs <= 0 && !firedExpired) {
        firedExpired = true;
        onExpired?.();
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadlineMs, hasResponded]);

  // Update state if respondedAt changes dynamically
  useEffect(() => {
    if (hasResponded) {
      setRemaining({ hours: 0, minutes: 0, seconds: 0, totalMs: 0, status: 'responded' });
    }
  }, [hasResponded]);

  const pillClass = statusToPillClass(remaining.status);
  const label = statusLabel(remaining.status, variant);

  const timeStr =
    remaining.status === 'responded'
      ? 'RESPONDED'
      : remaining.status === 'expired'
        ? 'EXPIRED'
        : `${pad(remaining.hours)}:${pad(remaining.minutes)}:${pad(remaining.seconds)}`;

  if (compact) {
    return (
      <span
        className={`pill ${pillClass} deadline-pill`}
        role="timer"
        aria-label={`${label}: ${timeStr}`}
        aria-live="polite"
        data-testid="deadline-timer-compact"
      >
        {remaining.status === 'expired' ? (
          <span className="deadline-expired-icon" aria-hidden="true">!</span>
        ) : remaining.status === 'responded' ? (
          <span className="deadline-responded-icon" aria-hidden="true" />
        ) : (
          <span className="deadline-clock-icon" aria-hidden="true" />
        )}
        {timeStr}
      </span>
    );
  }

  const deadlineLabel = variantLabel(variant);

  return (
    <div
      className={`deadline-timer deadline-${remaining.status}`}
      role="timer"
      aria-label={`${deadlineLabel}: ${timeStr} remaining`}
      aria-live="polite"
      data-testid="deadline-timer"
    >
      <div className="deadline-timer-header">
        <span className={`pill ${pillClass}`}>{label}</span>
      </div>
      <div className="deadline-timer-countdown" data-testid="deadline-countdown">
        {timeStr}
      </div>
      <div className="deadline-timer-label muted-text">
        {remaining.status === 'responded'
          ? `Target party responded at ${new Date(respondedAt!).toLocaleString()}. No auto-ruling needed.`
          : remaining.status === 'expired'
            ? variant === 'response'
              ? 'The 72-hour response window has closed. Default ruling has been applied in favor of the opener.'
              : 'The 72-hour appeal window has closed. Default ruling has been applied.'
            : `${deadlineLabel}: ${new Date(appealDeadlineAt).toLocaleString()}`}
      </div>
    </div>
  );
}

/**
 * Hook to get the deadline status without rendering a timer.
 * Useful for conditional styling of parent components.
 */
export function useDeadlineStatus(
  appealDeadlineAt: string,
  respondedAt?: string
): DeadlineStatus {
  const deadlineMs = new Date(appealDeadlineAt).getTime();
  const hasResponded = Boolean(respondedAt);
  const [status, setStatus] = useState<DeadlineStatus>(() =>
    hasResponded ? 'responded' : computeRemaining(deadlineMs).status
  );

  useEffect(() => {
    if (hasResponded) {
      setStatus('responded');
      return;
    }

    const interval = setInterval(() => {
      setStatus(computeRemaining(deadlineMs).status);
    }, 10_000); // check every 10s for status changes

    return () => clearInterval(interval);
  }, [deadlineMs, hasResponded]);

  return status;
}
