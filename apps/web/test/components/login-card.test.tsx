import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginCard } from '../../components/login-card';

describe('LoginCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    global.fetch = vi.fn();
  });

  it('renders the BFF Session badge', () => {
    render(<LoginCard />);
    expect(screen.getByText('BFF Session')).toBeInTheDocument();
  });

  it('renders the identity token input with default value', () => {
    render(<LoginCard />);
    const input = screen.getByPlaceholderText('mbtok_...');
    expect(input).toHaveValue('mbtok_demo_requester');
  });

  it('renders the role select with default value of requester', () => {
    render(<LoginCard />);
    const select = screen.getByRole('combobox');
    expect(select).toHaveValue('requester');
  });

  it('renders all four role options', () => {
    render(<LoginCard />);
    const options = screen.getAllByRole('option');
    const values = options.map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain('requester');
    expect(values).toContain('worker');
    expect(values).toContain('moderator');
    expect(values).toContain('admin');
  });

  it('renders the "Create Session" button (with aria-label for BFF session)', () => {
    render(<LoginCard />);
    expect(screen.getByRole('button', { name: 'Create a BFF session with the provided token' })).toBeInTheDocument();
  });

  it('updates identity token input when user types', async () => {
    const user = userEvent.setup();
    render(<LoginCard />);
    const input = screen.getByPlaceholderText('mbtok_...');
    await user.clear(input);
    await user.type(input, 'mbtok_new_token');
    expect(input).toHaveValue('mbtok_new_token');
  });

  it('updates role when user changes select', async () => {
    const user = userEvent.setup();
    render(<LoginCard />);
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'worker');
    expect(select).toHaveValue('worker');
  });

  it('calls POST /api/auth/exchange on button click', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_123', role: 'requester' })
    } as Response);

    render(<LoginCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a BFF session with the provided token' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/auth/exchange',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('sends identity token and role in request body', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_123', role: 'requester' })
    } as Response);

    render(<LoginCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a BFF session with the provided token' }));

    await waitFor(() => {
      const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(options.body as string);
      expect(body).toEqual({ identityToken: 'mbtok_demo_requester', role: 'requester' });
    });
  });

  it('shows success message after session is created', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_xyz', role: 'worker' })
    } as Response);

    render(<LoginCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a BFF session with the provided token' }));

    await waitFor(() => {
      expect(screen.getByText('Session created for agent_xyz (worker)')).toBeInTheDocument();
    });
  });

  it('shows error message when exchange fails', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Identity token invalid' } })
    } as Response);

    render(<LoginCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a BFF session with the provided token' }));

    await waitFor(() => {
      expect(screen.getByText('Failed: Identity token invalid')).toBeInTheDocument();
    });
  });

  it('shows "unknown error" when error response has no message', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({})
    } as Response);

    render(<LoginCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a BFF session with the provided token' }));

    await waitFor(() => {
      expect(screen.getByText('Failed: unknown error')).toBeInTheDocument();
    });
  });

  it('does not show any message initially', () => {
    render(<LoginCard />);
    // No message paragraph should be present
    expect(screen.queryByText(/Session created|Failed/)).toBeNull();
  });
});
