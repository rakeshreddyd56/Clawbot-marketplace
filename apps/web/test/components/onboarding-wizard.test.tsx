import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OnboardingWizard } from '../../components/onboarding-wizard';

// Mock bffFetch
vi.mock('../../components/api', () => ({
  bffFetch: vi.fn()
}));

// Mock next/link (used inside the wizard for console navigation links)
vi.mock('next/link', () => ({
  default: ({
    href,
    children
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>
}));

import { bffFetch } from '../../components/api';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const snapshotAllowed = {
  snapshot: {
    valid: true,
    checkedAt: '2026-03-02T00:00:00Z',
    trustedUntilAt: '2026-03-02T00:50:00Z',
    expiresAt: '2026-03-02T01:00:00Z',
    trustTier: 'A' as const,
    hardBlocked: false,
    blockReasons: [],
    agent: {
      id: 'agent_worker_001',
      name: 'Alice Worker',
      karma: 120,
      isClaimed: true,
      stats: { posts: 10, comments: 50 },
      owner: { xVerified: true, xHandle: 'alicew' }
    }
  },
  activationAllowed: true
};

const snapshotBlocked = {
  ...snapshotAllowed,
  snapshot: {
    ...snapshotAllowed.snapshot,
    hardBlocked: true,
    blockReasons: [{ code: 'UNCLAIMED_ACCOUNT', message: 'Account must be claimed.', blocking: true }]
  },
  activationAllowed: false
};

const statusResponse = {
  snapshot: snapshotAllowed.snapshot,
  freshness: {
    checkedAt: '2026-03-02T00:00:00Z',
    trustedUntilAt: '2026-03-02T00:50:00Z',
    expiresAt: '2026-03-02T01:00:00Z',
    needsReverifyPrompt: false,
    expired: false,
    secondsToExpiry: 600,
    trustTier: 'A' as const,
    hardBlocked: false
  }
};

const readinessResponse = {
  role: 'worker',
  trustTier: 'A',
  items: [
    { id: 'r1', label: 'Moltbook verified', status: 'PASS' as const, details: 'Token valid' },
    { id: 'r2', label: 'Constitution accepted', status: 'WARN' as const, details: 'Not yet accepted' }
  ],
  blockers: []
};

const eligibilityResponse = {
  trustTier: 'A' as const,
  canBid: true,
  canReserve: true,
  canPayout: true,
  payoutDelayHours: 0,
  blockReasons: []
};

describe('OnboardingWizard — Step 0 UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('renders the "Step 0" badge', () => {
    render(<OnboardingWizard />);
    expect(screen.getByText('Step 0')).toBeInTheDocument();
  });

  it('renders all four role selector buttons', () => {
    render(<OnboardingWizard />);
    expect(screen.getByRole('button', { name: 'Worker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Requester' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Moderator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });

  it('Worker role button is selected by default (has "selected" class)', () => {
    render(<OnboardingWizard />);
    expect(screen.getByRole('button', { name: 'Worker' })).toHaveClass('selected');
    expect(screen.getByRole('button', { name: 'Requester' })).not.toHaveClass('selected');
  });

  it('renders the identity token input with a default mbtok value', () => {
    render(<OnboardingWizard />);
    const input = screen.getByPlaceholderText('mbtok_...');
    expect((input as HTMLInputElement).value).toMatch(/^mbtok_/);
  });

  it('renders Max concurrency number input with default 2', () => {
    render(<OnboardingWizard />);
    const concurrency = screen.getByDisplayValue('2');
    expect(concurrency).toBeInTheDocument();
    expect((concurrency as HTMLInputElement).type).toBe('number');
  });

  it('renders the Capabilities input pre-filled with worker defaults', () => {
    render(<OnboardingWizard />);
    // default for worker is "python,sandbox-runtime"
    const capabilityInputs = screen.getAllByDisplayValue('python,sandbox-runtime');
    expect(capabilityInputs.length).toBeGreaterThanOrEqual(1);
  });

  it('switching to Requester role updates capability input and button selection', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await user.click(screen.getByRole('button', { name: 'Requester' }));
    expect(screen.getByRole('button', { name: 'Requester' })).toHaveClass('selected');
    expect(screen.getByRole('button', { name: 'Worker' })).not.toHaveClass('selected');
    // default for requester is "orchestrator"
    expect(screen.getByDisplayValue('orchestrator')).toBeInTheDocument();
  });

  it('switching to Moderator sets capability to moderation,evidence-review', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await user.click(screen.getByRole('button', { name: 'Moderator' }));
    expect(screen.getByDisplayValue('moderation,evidence-review')).toBeInTheDocument();
  });

  it('switching to Admin sets capability to governance,ops', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await user.click(screen.getByRole('button', { name: 'Admin' }));
    expect(screen.getByDisplayValue('governance,ops')).toBeInTheDocument();
  });

  it('renders four action buttons', () => {
    render(<OnboardingWizard />);
    expect(screen.getByRole('button', { name: '1. Verify identity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2. Create BFF session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3. Save capabilities' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4. Accept constitution' })).toBeInTheDocument();
  });

  it('"2. Create BFF session" is disabled before verify (no snapshot)', () => {
    render(<OnboardingWizard />);
    expect(screen.getByRole('button', { name: '2. Create BFF session' })).toBeDisabled();
  });

  it('"3. Save capabilities" is disabled before session is created', () => {
    render(<OnboardingWizard />);
    expect(screen.getByRole('button', { name: '3. Save capabilities' })).toBeDisabled();
  });

  it('"4. Accept constitution" is disabled before session is created', () => {
    render(<OnboardingWizard />);
    expect(screen.getByRole('button', { name: '4. Accept constitution' })).toBeDisabled();
  });

  it('shows the dynamic Moltbook auth URL link', () => {
    render(<OnboardingWizard />);
    const link = screen.getByRole('link');
    expect((link as HTMLAnchorElement).href).toContain('moltbook.com/auth.md');
    expect((link as HTMLAnchorElement).href).toContain('clawbot-marketplace');
  });
});

describe('OnboardingWizard — Step 1: Verify identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('calls bffFetch POST identity/moltbook/verify on verify click', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotAllowed);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'identity/moltbook/verify',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows "Verifying..." while verify is in flight', async () => {
    let resolve: (v: unknown) => void;
    vi.mocked(bffFetch).mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));

    expect(await screen.findByRole('button', { name: 'Verifying\u2026' })).toBeInTheDocument();
    // All other buttons should be disabled during loading
    expect(screen.getByRole('button', { name: '2. Create BFF session' })).toBeDisabled();

    // Resolve so cleanup doesn't hang
    resolve!(snapshotAllowed);
  });

  it('shows success message after successful verify when activation is allowed', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotAllowed);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText('Identity verified. Continue to session exchange.')).toBeInTheDocument();
    });
  });

  it('shows blocked message when activationAllowed is false', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotBlocked);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText('Trust gate blocked activation.')).toBeInTheDocument();
    });
  });

  it('shows error message on verify failure', async () => {
    vi.mocked(bffFetch).mockRejectedValueOnce(new Error('RATE_LIMITED: too many requests'));
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText('RATE_LIMITED: too many requests')).toBeInTheDocument();
    });
  });

  it('displays agent name in snapshot after verify', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotAllowed);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText('Alice Worker')).toBeInTheDocument();
    });
  });

  it('displays Trust Tier A pill after verify with tier A snapshot', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotAllowed);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText('Trust Tier A')).toBeInTheDocument();
    });
  });

  it('displays "Activation allowed" pill when hardBlocked is false', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotAllowed);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText('Activation allowed')).toBeInTheDocument();
    });
  });

  it('displays "Activation blocked" when hardBlocked is true', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotBlocked);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText('Activation blocked')).toBeInTheDocument();
    });
  });

  it('renders block reasons when blockReasons is non-empty', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotBlocked);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText(/UNCLAIMED_ACCOUNT/)).toBeInTheDocument();
    });
  });

  it('session button becomes enabled after successful verify (not hardBlocked)', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotAllowed);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '2. Create BFF session' })).not.toBeDisabled();
    });
  });

  it('session button stays disabled after verify when hardBlocked is true', async () => {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotBlocked);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await waitFor(() => {
      expect(screen.getByText('Activation blocked')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '2. Create BFF session' })).toBeDisabled();
  });
});

describe('OnboardingWizard — Step 2: Session exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  async function verifyFirst(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotAllowed);
    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await screen.findByText('Identity verified. Continue to session exchange.');
  }

  it('calls POST /api/auth/exchange on session create', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);
    vi.mocked(bffFetch)
      .mockResolvedValueOnce(snapshotAllowed)   // verify
      .mockResolvedValueOnce(statusResponse)     // loadSessionState → status
      .mockResolvedValueOnce(readinessResponse)  // loadSessionState → readiness
      .mockResolvedValueOnce(eligibilityResponse); // loadSessionState → eligibility

    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await verifyFirst(user);

    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/auth/exchange',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows session issued message after successful exchange', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);
    vi.mocked(bffFetch)
      .mockResolvedValueOnce(snapshotAllowed)
      .mockResolvedValueOnce(statusResponse)
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await verifyFirst(user);

    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));
    await waitFor(() => {
      expect(screen.getByText('Session issued for agent_001.')).toBeInTheDocument();
    });
  });

  it('shows error when session exchange returns non-ok', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: { code: 'TOKEN_EXPIRED', message: 'Identity token has expired.' }
      })
    } as Response);
    vi.mocked(bffFetch).mockResolvedValueOnce(snapshotAllowed);

    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await verifyFirst(user);

    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));
    await waitFor(() => {
      expect(screen.getByText(/TOKEN_EXPIRED: Identity token has expired./)).toBeInTheDocument();
    });
  });

  it('shows console navigation links after session is created', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);
    vi.mocked(bffFetch)
      .mockResolvedValueOnce(snapshotAllowed)
      .mockResolvedValueOnce(statusResponse)
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await verifyFirst(user);

    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Open worker console' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open requester console' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open moderator console' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open admin console' })).toBeInTheDocument();
    });
  });

  it('shows readiness items after session is created', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);
    vi.mocked(bffFetch)
      .mockResolvedValueOnce(snapshotAllowed)
      .mockResolvedValueOnce(statusResponse)
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await verifyFirst(user);

    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));
    await waitFor(() => {
      expect(screen.getByText('Moltbook verified')).toBeInTheDocument();
      expect(screen.getByText('Constitution accepted')).toBeInTheDocument();
    });
  });

  it('shows worker eligibility pills after session created in worker role', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);
    vi.mocked(bffFetch)
      .mockResolvedValueOnce(snapshotAllowed)
      .mockResolvedValueOnce(statusResponse)
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await verifyFirst(user);

    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));
    await waitFor(() => {
      expect(screen.getByText('Bid allowed')).toBeInTheDocument();
      expect(screen.getByText('Reserve allowed')).toBeInTheDocument();
      expect(screen.getByText('Payout allowed')).toBeInTheDocument();
    });
  });

  it('shows "3. Save capabilities" enabled after session is created', async () => {
    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);
    vi.mocked(bffFetch)
      .mockResolvedValueOnce(snapshotAllowed)
      .mockResolvedValueOnce(statusResponse)
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await verifyFirst(user);

    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '3. Save capabilities' })).not.toBeDisabled();
    });
  });
});

describe('OnboardingWizard — Step 3/4: Save capabilities & accept constitution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  async function setupSessionCreated(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(bffFetch)
      .mockResolvedValueOnce(snapshotAllowed)   // verify
      .mockResolvedValueOnce(statusResponse)     // status after exchange
      .mockResolvedValueOnce(readinessResponse)  // readiness after exchange
      .mockResolvedValueOnce(eligibilityResponse); // eligibility after exchange

    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);

    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await screen.findByText('Identity verified. Continue to session exchange.');
    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));
    await screen.findByText('Session issued for agent_001.');
  }

  it('calls bffFetch POST agents/me/capabilities on save capabilities', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await setupSessionCreated(user);

    vi.mocked(bffFetch)
      .mockResolvedValueOnce({})               // capabilities save
      .mockResolvedValueOnce(statusResponse)   // reload status
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    await user.click(screen.getByRole('button', { name: '3. Save capabilities' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'agents/me/capabilities',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows "Capabilities saved." after save succeeds', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await setupSessionCreated(user);

    vi.mocked(bffFetch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(statusResponse)
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    await user.click(screen.getByRole('button', { name: '3. Save capabilities' }));
    await waitFor(() => {
      expect(screen.getByText('Capabilities saved.')).toBeInTheDocument();
    });
  });

  it('calls bffFetch POST agents/me/constitution/accept', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await setupSessionCreated(user);

    vi.mocked(bffFetch)
      .mockResolvedValueOnce({})               // constitution accept
      .mockResolvedValueOnce(statusResponse)   // reload
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    await user.click(screen.getByRole('button', { name: '4. Accept constitution' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'agents/me/constitution/accept',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows constitution accepted message', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await setupSessionCreated(user);

    vi.mocked(bffFetch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(statusResponse)
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    await user.click(screen.getByRole('button', { name: '4. Accept constitution' }));
    await waitFor(() => {
      expect(screen.getByText('Constitution accepted. Marketplace actions unlocked by policy.')).toBeInTheDocument();
    });
  });
});

describe('OnboardingWizard — Step 5-6: Freshness + re-verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('shows freshness pill after session is created', async () => {
    const user = userEvent.setup();
    vi.mocked(bffFetch)
      .mockResolvedValueOnce(snapshotAllowed)
      .mockResolvedValueOnce(statusResponse)
      .mockResolvedValueOnce(readinessResponse)
      .mockResolvedValueOnce(eligibilityResponse);

    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);

    render(<OnboardingWizard />);
    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await screen.findByText('Identity verified. Continue to session exchange.');
    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));

    await waitFor(() => {
      expect(screen.getByText('Fresh (600s left)')).toBeInTheDocument();
    });
  });

  it('shows "Re-verify now" button in readiness section once session is active', async () => {
    const user = userEvent.setup();
    vi.mocked(bffFetch).mockImplementation(async (path: string) => {
      if (path === 'identity/moltbook/verify') return snapshotAllowed;
      if (path === 'identity/moltbook/status') return statusResponse;
      if (path.startsWith('onboarding/readiness')) return readinessResponse;
      if (path === 'worker/eligibility') return eligibilityResponse;
      throw new Error(`Unexpected bffFetch path: ${path}`);
    });

    vi.mocked(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'agent_001', role: 'worker' })
    } as Response);

    render(<OnboardingWizard />);
    await user.click(screen.getByRole('button', { name: '1. Verify identity' }));
    await screen.findByText('Identity verified. Continue to session exchange.');
    await user.click(screen.getByRole('button', { name: '2. Create BFF session' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Re-verify your session now' })).toBeInTheDocument();
    });
  });
});
