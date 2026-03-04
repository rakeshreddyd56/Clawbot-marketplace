import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from '../../app/admin/page';

// ─── Mock external dependencies ───────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  usePathname: vi.fn().mockReturnValue('/admin')
}));

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  )
}));

vi.mock('../../components/api', () => ({
  bffFetch: vi.fn()
}));

import { bffFetch } from '../../components/api';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const eligibilityTierA = {
  trustTier: 'A' as const,
  canBid: true,
  canReserve: true,
  canPayout: true,
  payoutDelayHours: 0,
  blockReasons: []
};

const eligibilityTierC = {
  trustTier: 'C' as const,
  canBid: true,
  canReserve: false,
  canPayout: false,
  payoutDelayHours: 0,
  blockReasons: [{ code: 'TIER_C_RESTRICTION', message: 'Tier C cannot reserve.' }]
};

const policyDecisions = [
  { decisionId: 'dec_001', action: 'task.create', allow: true, reason: 'requester role', policyVersion: 'v1' },
  { decisionId: 'dec_002', action: 'payout.initiate', allow: false, reason: 'tier C restricted', policyVersion: 'v1' },
  { decisionId: 'dec_003', action: 'task.bid', allow: true, reason: 'worker role + tier A', policyVersion: 'v1' }
];

const freshnessStatus = {
  freshness: {
    needsReverifyPrompt: false,
    expired: false,
    secondsToExpiry: 600,
    trustTier: 'A' as const
  }
};

describe('AdminPage — Initial render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bffFetch).mockResolvedValue(freshnessStatus);
  });

  it('renders the Admin Console title', async () => {
    render(<AdminPage />);
    expect(screen.getByText('Admin Console')).toBeInTheDocument();
  });

  it('renders the subtitle', async () => {
    render(<AdminPage />);
    expect(screen.getByText(/Policy, trust-tier eligibility checks/)).toBeInTheDocument();
  });

  it('renders "Worker Eligibility Probe" badge', async () => {
    render(<AdminPage />);
    expect(screen.getByText('Worker Eligibility Probe')).toBeInTheDocument();
  });

  it('renders "Policy Decisions" badge', async () => {
    render(<AdminPage />);
    expect(screen.getByText('Policy Decisions')).toBeInTheDocument();
  });

  it('renders Agent ID input field', async () => {
    render(<AdminPage />);
    expect(screen.getByPlaceholderText('agent_...')).toBeInTheDocument();
  });

  it('renders Check eligibility button (disabled without agentId)', async () => {
    render(<AdminPage />);
    expect(screen.getByRole('button', { name: 'Check eligibility' })).toBeDisabled();
  });

  it('renders Load policy log button', async () => {
    render(<AdminPage />);
    expect(screen.getByRole('button', { name: 'Load policy log' })).toBeInTheDocument();
  });

  it('shows "Enter an agent ID..." placeholder when no eligibility loaded', async () => {
    render(<AdminPage />);
    expect(screen.getByText('Enter an agent ID to inspect tier-derived worker rights.')).toBeInTheDocument();
  });

  it('does NOT show policy decision rows initially (decisionsLoaded gate)', async () => {
    render(<AdminPage />);
    // Policy decisions section only shows rows after a load completes
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('renders Admin Evidence Rail', async () => {
    render(<AdminPage />);
    expect(screen.getAllByText('Admin Evidence Rail').length).toBeGreaterThanOrEqual(1);
  });
});

describe('AdminPage — Worker eligibility probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables Check eligibility button when agentId is typed', async () => {
    vi.mocked(bffFetch).mockResolvedValue(freshnessStatus);
    const user = userEvent.setup();
    render(<AdminPage />);

    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_001');
    expect(screen.getByRole('button', { name: 'Check eligibility' })).not.toBeDisabled();
  });

  it('calls GET worker/eligibility?agentId=... when Check eligibility is clicked', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibilityTierA);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_001');
    await user.click(screen.getByRole('button', { name: 'Check eligibility' }));

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'worker/eligibility?agentId=agent_worker_001'
      );
    });
  });

  it('displays trust tier A result', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibilityTierA);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_001');
    await user.click(screen.getByRole('button', { name: 'Check eligibility' }));

    await waitFor(() => {
      // Trust tier value in kv-grid
      expect(screen.getAllByText('A').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays bid, reserve, payout as Allowed for tier A', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibilityTierA);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_001');
    await user.click(screen.getByRole('button', { name: 'Check eligibility' }));

    await waitFor(() => {
      // kv-grid shows 'Allowed' for Bid, Reserve, Payout
      const allowedValues = screen.getAllByText('Allowed');
      expect(allowedValues.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('displays canReserve=false for tier C agent', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibilityTierC);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_tier_c');
    await user.click(screen.getByRole('button', { name: 'Check eligibility' }));

    await waitFor(() => {
      // kv-grid shows 'Blocked' for Reserve + Payout; evidence rail shows 'false' strings
      const blockedValues = screen.getAllByText('Blocked');
      expect(blockedValues.length).toBeGreaterThanOrEqual(2); // canReserve + canPayout
    });
  });

  it('shows "Checking\u2026" during eligibility check', async () => {
    let resolveEligibility!: (v: unknown) => void;
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.startsWith('worker/eligibility')) {
        return new Promise((r) => { resolveEligibility = r; });
      }
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_001');
    await user.click(screen.getByRole('button', { name: 'Check eligibility' }));

    expect(await screen.findByRole('button', { name: /checking/i })).toBeInTheDocument();
    resolveEligibility(eligibilityTierA);
  });

  it('shows error when eligibility load fails', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.startsWith('worker/eligibility')) {
        return Promise.reject(new Error('ELIGIBILITY_ERROR: agent not found'));
      }
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_unknown');
    await user.click(screen.getByRole('button', { name: 'Check eligibility' }));

    await waitFor(() => {
      expect(screen.getByText('ELIGIBILITY_ERROR: agent not found')).toBeInTheDocument();
    });
  });

  it('updates evidence rail with queried agent info', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibilityTierA);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_001');
    await user.click(screen.getByRole('button', { name: 'Check eligibility' }));

    await waitFor(() => {
      // Evidence rail should show the queried agent
      expect(screen.getAllByText('agent_worker_001').length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('AdminPage — Policy decisions log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads policy decisions from GET policy/decisions', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: policyDecisions });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('policy/decisions');
    });
  });

  it('displays each policy decision action', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: policyDecisions });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      expect(screen.getByText('task.create')).toBeInTheDocument();
      expect(screen.getByText('payout.initiate')).toBeInTheDocument();
      expect(screen.getByText('task.bid')).toBeInTheDocument();
    });
  });

  it('displays ALLOW pill for allowed decisions', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: policyDecisions });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      const allowPills = screen.getAllByText('ALLOW');
      expect(allowPills.length).toBe(2); // task.create + task.bid
    });
  });

  it('displays DENY pill for denied decisions', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: policyDecisions });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      const denyPills = screen.getAllByText('DENY');
      expect(denyPills.length).toBe(1); // payout.initiate
    });
  });

  it('ALLOW pill has pill-ok class', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: policyDecisions });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      const allowPill = screen.getAllByText('ALLOW')[0];
      expect(allowPill).toHaveClass('pill-ok');
    });
  });

  it('DENY pill has pill-bad class', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: policyDecisions });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      const denyPill = screen.getByText('DENY');
      expect(denyPill).toHaveClass('pill-bad');
    });
  });

  it('shows decisionId and policyVersion as muted subtext', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: policyDecisions });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      expect(screen.getByText(/dec_001 · v1/)).toBeInTheDocument();
    });
  });

  it('shows "Loading\u2026" during policy log load', async () => {
    let resolveDecisions!: (v: unknown) => void;
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') {
        return new Promise((r) => { resolveDecisions = r; });
      }
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    expect(await screen.findByRole('button', { name: /loading/i })).toBeInTheDocument();

    resolveDecisions({ decisions: [] });
  });

  it('shows "No policy decisions recorded." after empty load', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: [] });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      expect(screen.getByText('No policy decisions recorded.')).toBeInTheDocument();
    });
  });

  it('shows error when policy log load fails', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') {
        return Promise.reject(new Error('POLICY_ERROR: unauthorized'));
      }
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      expect(screen.getByText('POLICY_ERROR: unauthorized')).toBeInTheDocument();
    });
  });

  it('shows last 50 decisions in reverse order (newest first)', async () => {
    // Generate 60 decisions; the last 50 reversed → newest first
    const manyDecisions = Array.from({ length: 60 }, (_, i) => ({
      decisionId: `dec_${i}`,
      action: `action_${i}`,
      allow: true,
      reason: '',
      policyVersion: 'v1'
    }));

    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'policy/decisions') return Promise.resolve({ decisions: manyDecisions });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<AdminPage />);

    await user.click(screen.getByRole('button', { name: 'Load policy log' }));
    await waitFor(() => {
      // slice(-50) takes indices 10..59, then reverse → dec_59 first
      expect(screen.getByText('action_59')).toBeInTheDocument();
      // dec_9 and earlier should NOT appear
      expect(screen.queryByText('action_9')).toBeNull();
    });
  });
});
