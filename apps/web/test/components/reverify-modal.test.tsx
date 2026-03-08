import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReverifyModal } from '../../components/reverify-modal';

vi.mock('../../components/api', () => ({
  bffFetch: vi.fn()
}));

import { bffFetch } from '../../components/api';

describe('ReverifyModal', () => {
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders as a modal dialog', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('has aria-modal="true"', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('renders "Session Expired" badge', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    expect(screen.getByText('Session Expired')).toBeInTheDocument();
  });

  it('renders the title "Your identity has expired."', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    expect(screen.getByText('Your identity has expired.')).toBeInTheDocument();
  });

  it('renders description text about 60-minute expiry', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    expect(screen.getByText(/Sessions expire after 60 minutes/)).toBeInTheDocument();
  });

  it('renders a token input with placeholder', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    expect(screen.getByPlaceholderText('mbtok_...')).toBeInTheDocument();
  });

  it('renders the "Re-verify identity" button', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    expect(screen.getByRole('button', { name: 'Re-verify identity' })).toBeInTheDocument();
  });

  it('renders moltbook.com link', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    const link = screen.getByRole('link', { name: 'moltbook.com' });
    expect(link).toHaveAttribute('href', 'https://moltbook.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // ── Button disabled state ──────────────────────────────────────────────────

  it('disables submit button when token is empty', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    expect(screen.getByRole('button', { name: 'Re-verify identity' })).toBeDisabled();
  });

  it('enables submit button when token is entered', async () => {
    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);
    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_new');
    expect(screen.getByRole('button', { name: 'Re-verify identity' })).not.toBeDisabled();
  });

  // ── Successful submission ──────────────────────────────────────────────────

  it('calls bffFetch POST sessions/reverify with trimmed token on submit', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), '  mbtok_fresh  ');
    await user.click(screen.getByRole('button', { name: 'Re-verify identity' }));

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

  it('calls onSuccess after successful re-verification', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_fresh');
    await user.click(screen.getByRole('button', { name: 'Re-verify identity' }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledOnce();
    });
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('shows "Verifying..." while request is in flight', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(bffFetch).mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_fresh');
    await user.click(screen.getByRole('button', { name: 'Re-verify identity' }));

    expect(await screen.findByText('Verifying\u2026')).toBeInTheDocument();
    resolve({});
  });

  it('disables submit button during loading', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(bffFetch).mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_fresh');
    await user.click(screen.getByRole('button', { name: 'Re-verify identity' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verifying\u2026' })).toBeDisabled();
    });
    resolve({});
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it('shows error message with "Block reason:" prefix on failure', async () => {
    vi.mocked(bffFetch).mockRejectedValueOnce(new Error('BANNED: agent permanently banned'));
    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_old');
    await user.click(screen.getByRole('button', { name: 'Re-verify identity' }));

    await waitFor(() => {
      expect(screen.getByText(/Block reason:/)).toBeInTheDocument();
      expect(screen.getByText(/BANNED: agent permanently banned/)).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows generic fallback error for non-Error exceptions', async () => {
    vi.mocked(bffFetch).mockRejectedValueOnce(42);
    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_bad');
    await user.click(screen.getByRole('button', { name: 'Re-verify identity' }));

    await waitFor(() => {
      expect(screen.getByText(/Re-verification failed/)).toBeInTheDocument();
    });
  });

  it('re-enables button after error so user can retry', async () => {
    vi.mocked(bffFetch).mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_bad');
    await user.click(screen.getByRole('button', { name: 'Re-verify identity' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Re-verify identity' })).not.toBeDisabled();
    });
  });

  // ── Enter key shortcut ─────────────────────────────────────────────────────

  it('submits on Enter key in input', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<ReverifyModal onSuccess={onSuccess} />);

    await user.type(screen.getByPlaceholderText('mbtok_...'), 'mbtok_fresh{Enter}');

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'sessions/reverify',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // ── Accessibility ──────────────────────────────────────────────────────────

  it('has aria-labelledby pointing to title', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'reverify-modal-title');
    expect(document.getElementById('reverify-modal-title')?.textContent).toBe('Your identity has expired.');
  });

  it('has aria-describedby pointing to description', () => {
    render(<ReverifyModal onSuccess={onSuccess} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-describedby', 'reverify-modal-desc');
  });
});
