import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { IdentityStrip } from '../../components/identity-strip';

// Mock bffFetch
vi.mock('../../components/api', () => ({
  bffFetch: vi.fn()
}));

import { bffFetch } from '../../components/api';

const freshFreshness = {
  needsReverifyPrompt: false,
  expired: false,
  secondsToExpiry: 600,
  trustTier: 'A' as const
};

const staleButNotExpired = {
  needsReverifyPrompt: true,
  expired: false,
  secondsToExpiry: 45,
  trustTier: 'B' as const
};

const expiredFreshness = {
  needsReverifyPrompt: false,
  expired: true,
  secondsToExpiry: 0,
  trustTier: 'C' as const
};

describe('IdentityStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls bffFetch for identity status on mount', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });

    render(<IdentityStrip />);
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('identity/moltbook/status');
    });
  });

  it('displays fresh pill after loading', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });

    render(<IdentityStrip />);
    await waitFor(() => {
      expect(screen.getByText('Fresh (600s left)')).toBeInTheDocument();
    });
  });

  it('displays trust tier A pill', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });

    render(<IdentityStrip />);
    await waitFor(() => {
      expect(screen.getByText('Trust Tier A')).toBeInTheDocument();
    });
  });

  it('shows re-verify button when needsReverifyPrompt is true', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: staleButNotExpired });

    render(<IdentityStrip />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Re-verify your session to refresh identity freshness' })).toBeInTheDocument();
    });
  });

  it('shows re-verify button when expired is true', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: expiredFreshness });

    render(<IdentityStrip />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Re-verify your session to refresh identity freshness' })).toBeInTheDocument();
    });
  });

  it('does NOT show re-verify button when session is fresh', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });

    render(<IdentityStrip />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Re-verify your session to refresh identity freshness' })).toBeNull();
    });
  });

  it('shows error message when status fetch fails', async () => {
    vi.mocked(bffFetch).mockRejectedValue(new Error('AUTH_REQUIRED: session expired'));

    render(<IdentityStrip />);
    await waitFor(() => {
      expect(screen.getByText('AUTH_REQUIRED: session expired')).toBeInTheDocument();
    });
  });

  it('shows generic error message for non-Error failures', async () => {
    vi.mocked(bffFetch).mockRejectedValue('unexpected failure');

    render(<IdentityStrip />);
    await waitFor(() => {
      expect(screen.getByText('Unable to load identity status.')).toBeInTheDocument();
    });
  });

  it('calls reverify endpoint when re-verify button is clicked', async () => {
    // First call: load status (stale) → second call: reverify → third call: reload status
    vi.mocked(bffFetch)
      .mockResolvedValueOnce({ freshness: staleButNotExpired })
      .mockResolvedValueOnce({}) // reverify
      .mockResolvedValueOnce({ freshness: freshFreshness }); // reload

    render(<IdentityStrip />);
    const btn = await screen.findByRole('button', { name: 'Re-verify your session to refresh identity freshness' });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'sessions/reverify',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows "Session re-verified." message after successful reverify', async () => {
    vi.mocked(bffFetch)
      .mockResolvedValueOnce({ freshness: staleButNotExpired })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ freshness: freshFreshness });

    render(<IdentityStrip />);
    const btn = await screen.findByRole('button', { name: 'Re-verify your session to refresh identity freshness' });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText('Session re-verified.')).toBeInTheDocument();
    });
  });

  it('shows error message when reverify fails', async () => {
    vi.mocked(bffFetch)
      .mockResolvedValueOnce({ freshness: staleButNotExpired })
      .mockRejectedValueOnce(new Error('REVERIFY_FAILED: token invalid'));

    render(<IdentityStrip />);
    const btn = await screen.findByRole('button', { name: 'Re-verify your session to refresh identity freshness' });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText('REVERIFY_FAILED: token invalid')).toBeInTheDocument();
    });
  });

  it('renders "Runtime Identity" badge', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });

    render(<IdentityStrip />);
    expect(screen.getByText('Runtime Identity')).toBeInTheDocument();
  });

  it('renders signature pill with valid=true when signatureValid prop is true', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });

    render(<IdentityStrip signatureValid={true} />);
    await waitFor(() => {
      expect(screen.getByText('Signature valid')).toBeInTheDocument();
    });
  });

  it('renders signature pill with invalid when signatureValid prop is false', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });

    render(<IdentityStrip signatureValid={false} />);
    await waitFor(() => {
      expect(screen.getByText('Signature invalid')).toBeInTheDocument();
    });
  });

  it('renders heartbeat pill with leaseExpiresAt when provided', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-02T00:00:00Z'));

    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    render(<IdentityStrip leaseExpiresAt={expiresAt} />);

    expect(screen.getByText('Lease heartbeat 90s')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('renders idle heartbeat pill when leaseExpiresAt is not provided', async () => {
    vi.mocked(bffFetch).mockResolvedValue({ freshness: freshFreshness });

    render(<IdentityStrip />);
    expect(screen.getByText('Lease heartbeat idle')).toBeInTheDocument();
  });
});
