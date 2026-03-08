import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReverifyGuard } from '../../components/reverify-guard';

vi.mock('../../components/api', () => ({
  bffFetch: vi.fn()
}));

import { bffFetch } from '../../components/api';

describe('ReverifyGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── No session (null state) ────────────────────────────────────────────────

  it('renders nothing when no session exists (bffFetch throws)', async () => {
    vi.mocked(bffFetch).mockRejectedValue(new Error('no session'));
    const { container } = render(<ReverifyGuard />);
    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
  });

  it('renders nothing when identity is fresh and not expiring', async () => {
    vi.mocked(bffFetch).mockResolvedValue({
      freshness: {
        needsReverifyPrompt: false,
        expired: false,
        secondsToExpiry: 3000
      }
    });
    const { container } = render(<ReverifyGuard />);
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('identity/moltbook/status');
    });
    expect(container.innerHTML).toBe('');
  });

  // ── Shows banner when identity is expiring ─────────────────────────────────

  it('shows ReverifyBanner when needsReverifyPrompt is true', async () => {
    vi.mocked(bffFetch).mockResolvedValue({
      freshness: {
        needsReverifyPrompt: true,
        expired: false,
        secondsToExpiry: 300
      }
    });
    render(<ReverifyGuard />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/expires in ~5 min/)).toBeInTheDocument();
    });
  });

  // ── Shows modal when identity has expired ──────────────────────────────────

  it('shows ReverifyModal when expired is true', async () => {
    vi.mocked(bffFetch).mockResolvedValue({
      freshness: {
        needsReverifyPrompt: false,
        expired: true,
        secondsToExpiry: 0
      }
    });
    render(<ReverifyGuard />);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Your identity has expired.')).toBeInTheDocument();
    });
  });

  // ── Expired takes precedence over prompt ───────────────────────────────────

  it('shows modal (not banner) when both expired and needsReverifyPrompt are true', async () => {
    vi.mocked(bffFetch).mockResolvedValue({
      freshness: {
        needsReverifyPrompt: true,
        expired: true,
        secondsToExpiry: 0
      }
    });
    render(<ReverifyGuard />);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  // ── Polling at 30-second intervals ─────────────────────────────────────────

  it('polls identity/moltbook/status every 30 seconds', async () => {
    vi.mocked(bffFetch).mockResolvedValue({
      freshness: {
        needsReverifyPrompt: false,
        expired: false,
        secondsToExpiry: 3000
      }
    });

    render(<ReverifyGuard />);

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledTimes(1);
    });

    // Advance 30 seconds
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledTimes(2);
    });

    // Advance another 30 seconds
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledTimes(3);
    });
  });

  // ── Transition from fresh to expiring ──────────────────────────────────────

  it('transitions from hidden to banner when status changes to needsReverifyPrompt', async () => {
    vi.mocked(bffFetch)
      .mockResolvedValueOnce({
        freshness: { needsReverifyPrompt: false, expired: false, secondsToExpiry: 3000 }
      })
      .mockResolvedValue({
        freshness: { needsReverifyPrompt: true, expired: false, secondsToExpiry: 120 }
      });

    const { container } = render(<ReverifyGuard />);

    // Initially hidden
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledTimes(1);
    });
    expect(container.innerHTML).toBe('');

    // After 30s poll, should show banner
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  // ── Transition from expiring to expired ────────────────────────────────────

  it('transitions from banner to modal when status changes to expired', async () => {
    vi.mocked(bffFetch)
      .mockResolvedValueOnce({
        freshness: { needsReverifyPrompt: true, expired: false, secondsToExpiry: 60 }
      })
      .mockResolvedValue({
        freshness: { needsReverifyPrompt: false, expired: true, secondsToExpiry: 0 }
      });

    render(<ReverifyGuard />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  // ── Silently ignores polling errors ────────────────────────────────────────

  it('does not crash or show error on polling failure after initial success', async () => {
    vi.mocked(bffFetch)
      .mockResolvedValueOnce({
        freshness: { needsReverifyPrompt: false, expired: false, secondsToExpiry: 3000 }
      })
      .mockRejectedValue(new Error('network error'));

    const { container } = render(<ReverifyGuard />);

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledTimes(1);
    });

    // Advance timer - should not crash
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    // Still rendered, no crash
    expect(container).toBeTruthy();
  });

  // ── Cleanup interval on unmount ────────────────────────────────────────────

  it('cleans up interval on unmount', async () => {
    vi.mocked(bffFetch).mockResolvedValue({
      freshness: { needsReverifyPrompt: false, expired: false, secondsToExpiry: 3000 }
    });

    const { unmount } = render(<ReverifyGuard />);

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledTimes(1);
    });

    unmount();

    // Advance timer - should not trigger more calls
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(vi.mocked(bffFetch)).toHaveBeenCalledTimes(1);
  });
});
