import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReverifyBanner } from '../../components/reverify-banner';

vi.mock('../../components/api', () => ({
  bffFetch: vi.fn()
}));

import { bffFetch } from '../../components/api';

describe('ReverifyBanner', () => {
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders the warning message with minutes remaining', () => {
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);
    expect(screen.getByText(/expires in ~5 min/)).toBeInTheDocument();
  });

  it('rounds up partial minutes (e.g. 90s = ~2 min)', () => {
    render(<ReverifyBanner secondsToExpiry={90} onSuccess={onSuccess} />);
    expect(screen.getByText(/expires in ~2 min/)).toBeInTheDocument();
  });

  it('shows ~1 min for values under 60 seconds', () => {
    render(<ReverifyBanner secondsToExpiry={30} onSuccess={onSuccess} />);
    expect(screen.getByText(/expires in ~1 min/)).toBeInTheDocument();
  });

  it('has role="alert" for screen readers', () => {
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders the token input with placeholder', () => {
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);
    expect(screen.getByPlaceholderText('mbtok_...')).toBeInTheDocument();
  });

  it('renders the Re-verify button', () => {
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);
    expect(screen.getByRole('button', { name: 'Re-verify' })).toBeInTheDocument();
  });

  it('renders the Dismiss button', () => {
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);
    expect(screen.getByRole('button', { name: 'Dismiss re-verify banner' })).toBeInTheDocument();
  });

  // ── Re-verify button disabled state ────────────────────────────────────────

  it('disables Re-verify button when token is empty', () => {
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);
    expect(screen.getByRole('button', { name: 'Re-verify' })).toBeDisabled();
  });

  it('disables Re-verify button when token is whitespace only', async () => {
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);
    await user.type(screen.getByPlaceholderText('mbtok_...'), '   ');
    expect(screen.getByRole('button', { name: 'Re-verify' })).toBeDisabled();
  });

  it('enables Re-verify button when token is entered', async () => {
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);
    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_fresh');
    expect(screen.getByRole('button', { name: 'Re-verify' })).not.toBeDisabled();
  });

  // ── Successful re-verification ─────────────────────────────────────────────

  it('calls bffFetch POST sessions/reverify with trimmed token', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), '  mbtok_fresh  ');
    await user.click(screen.getByRole('button', { name: 'Re-verify' }));

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'sessions/reverify',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ identityToken: 'mbtok_fresh' })
        })
      );
    });
  });

  it('calls onSuccess and hides banner after successful re-verify', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_fresh');
    await user.click(screen.getByRole('button', { name: 'Re-verify' }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledOnce();
    });
    // Banner should be dismissed (null render)
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('shows "Verifying..." during re-verify request', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(bffFetch).mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_fresh');
    await user.click(screen.getByRole('button', { name: 'Re-verify' }));

    expect(await screen.findByText('Verifying\u2026')).toBeInTheDocument();
    resolve({});
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it('shows error message when re-verify fails', async () => {
    vi.mocked(bffFetch).mockRejectedValueOnce(new Error('TOKEN_EXPIRED: identity token is stale'));
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_old');
    await user.click(screen.getByRole('button', { name: 'Re-verify' }));

    await waitFor(() => {
      expect(screen.getByText('TOKEN_EXPIRED: identity token is stale')).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows generic error when non-Error is thrown', async () => {
    vi.mocked(bffFetch).mockRejectedValueOnce('something unexpected');
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_bad');
    await user.click(screen.getByRole('button', { name: 'Re-verify' }));

    await waitFor(() => {
      expect(screen.getByText('Re-verification failed.')).toBeInTheDocument();
    });
  });

  it('does not dismiss banner on error', async () => {
    vi.mocked(bffFetch).mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_bad');
    await user.click(screen.getByRole('button', { name: 'Re-verify' }));

    await waitFor(() => {
      expect(screen.getByText('fail')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  // ── Dismiss ────────────────────────────────────────────────────────────────

  it('hides the banner when Dismiss is clicked', async () => {
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss re-verify banner' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not call onSuccess when dismissed', async () => {
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss re-verify banner' }));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  // ── Enter key shortcut ─────────────────────────────────────────────────────

  it('submits on Enter key press in input', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_fresh{Enter}');

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'sessions/reverify',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('does not submit on Enter when input is empty', async () => {
    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    const input = screen.getByPlaceholderText('mbtok_...');
    await user.click(input);
    await user.keyboard('{Enter}');

    expect(vi.mocked(bffFetch)).not.toHaveBeenCalled();
  });

  // ── Edge: error clears on retry ────────────────────────────────────────────

  it('clears previous error on retry attempt', async () => {
    vi.mocked(bffFetch)
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce({});

    const user = userEvent.setup();
    render(<ReverifyBanner secondsToExpiry={300} onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_bad');
    await user.click(screen.getByRole('button', { name: 'Re-verify' }));
    await waitFor(() => {
      expect(screen.getByText('first fail')).toBeInTheDocument();
    });

    // Retry with same token
    await user.click(screen.getByRole('button', { name: 'Re-verify' }));
    await waitFor(() => {
      expect(screen.queryByText('first fail')).toBeNull();
    });
  });
});
