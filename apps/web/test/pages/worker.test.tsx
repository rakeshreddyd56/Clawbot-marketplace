import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../test-utils';
import userEvent from '@testing-library/user-event';
import WorkerPage from '../../app/worker/page';

// ─── Mock all external dependencies ──────────────────────────────────────────

vi.mock('next/navigation', () => ({
  usePathname: vi.fn().mockReturnValue('/worker')
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

const tasks = [
  { taskId: 'task_001', title: 'Dataset Cleanup', pricingMode: 'fixed', budget: 100, deadlineAt: '2026-03-03T00:00:00Z', status: 'POSTED' },
  { taskId: 'task_002', title: 'Model Training', pricingMode: 'hourly', budget: 200, deadlineAt: '2026-03-04T00:00:00Z', status: 'POSTED' }
];

const eligibility = {
  trustTier: 'A' as const,
  canBid: true,
  canReserve: true,
  canPayout: true,
  payoutDelayHours: 0,
  blockReasons: []
};

// Combined response satisfying both IdentityStrip (freshness) and TrustTierCard (snapshot)
const statusAndFreshness = {
  freshness: {
    needsReverifyPrompt: false,
    expired: false,
    secondsToExpiry: 600,
    trustTier: 'A' as const
  },
  snapshot: {
    agent: { karma: 100, stats: { posts: 20, comments: 30 } }
  }
};

/**
 * Path-keyed mock dispatcher used as the default mock for all tests.
 * Handles concurrent calls from WorkerPage, TrustTierCard, and IdentityStrip
 * regardless of call ordering.
 */
function mockDefaultLoad() {
  vi.mocked(bffFetch).mockImplementation((path: string) => {
    if (path === 'tasks/public') return Promise.resolve({ tasks });
    if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
    if (path === 'identity/moltbook/status') return Promise.resolve(statusAndFreshness);
    return Promise.resolve({});
  });
}

describe('WorkerPage — Initial render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultLoad();
  });

  it('renders the Worker Console title', async () => {
    render(<WorkerPage />);
    expect(screen.getByText('Worker Console')).toBeInTheDocument();
  });

  it('renders the Worker Console subtitle', async () => {
    render(<WorkerPage />);
    expect(screen.getByText(/Bid, reserve, heartbeat, scope/)).toBeInTheDocument();
  });

  it('loads tasks and eligibility on mount', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('tasks/public');
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('worker/eligibility');
    });
  });

  it('renders task options in the task selector after skeleton clears', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      expect(screen.getByText(/Dataset Cleanup/)).toBeInTheDocument();
      expect(screen.getByText(/Model Training/)).toBeInTheDocument();
    });
  });

  it('renders the "Opportunities" badge after initial load completes', async () => {
    render(<WorkerPage />);
    // Opportunities is hidden behind SkeletonCard while initialLoading is true
    await waitFor(() => {
      expect(screen.getByText('Opportunities')).toBeInTheDocument();
    });
  });

  it('renders eligibility info paragraph after loading', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      // Component shows: "Eligibility — bid: yes · reserve: yes · payout: yes"
      expect(screen.getByText(/bid: yes.*reserve: yes.*payout: yes/)).toBeInTheDocument();
    });
  });

  it('renders Place bid button enabled when task is selected', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Place bid' })).not.toBeDisabled();
    });
  });

  it('renders Reserve lease button enabled when task is selected', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reserve lease' })).not.toBeDisabled();
    });
  });

  it('renders Heartbeat button disabled initially (no lease)', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      // aria-label when no lease: 'Heartbeat (requires active lease)'
      expect(screen.getByRole('button', { name: /heartbeat/i })).toBeDisabled();
    });
  });

  it('renders "Scope + Vault" badge', async () => {
    render(<WorkerPage />);
    expect(screen.getByText('Scope + Vault')).toBeInTheDocument();
  });

  it('renders Fetch scoped manifest button (disabled without lease)', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      // aria-label: "Fetch the scoped manifest for the active lease"
      expect(screen.getByRole('button', { name: /fetch.*scoped/i })).toBeDisabled();
    });
  });

  it('renders Mint vault token button (disabled without scope)', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      // aria-label: "Mint a vault token for the first allowed data reference"
      expect(screen.getByRole('button', { name: /mint.*vault/i })).toBeDisabled();
    });
  });

  it('shows hidden scope message before lease', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      expect(screen.getByText('Scope stays hidden until lease token checks pass.')).toBeInTheDocument();
    });
  });

  it('shows error message when loadState fails', async () => {
    vi.clearAllMocks();
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'tasks/public') return Promise.reject(new Error('API_ERROR: tasks unavailable'));
      return Promise.resolve(statusAndFreshness);
    });

    render(<WorkerPage />);
    await waitFor(() => {
      expect(screen.getByText('API_ERROR: tasks unavailable')).toBeInTheDocument();
    });
  });
});

describe('WorkerPage — Place bid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultLoad();
  });

  it('calls bffFetch POST tasks/{id}/bids on place bid', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/bids' && opts?.method === 'POST') return Promise.resolve({});
      return Promise.resolve(statusAndFreshness);
    });

    const user = userEvent.setup();
    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);

    await user.click(screen.getByRole('button', { name: 'Place bid' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'tasks/task_001/bids',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows "Bid placed on ..." message after bid', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/bids' && opts?.method === 'POST') return Promise.resolve({});
      return Promise.resolve(statusAndFreshness);
    });

    const user = userEvent.setup();
    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);

    await user.click(screen.getByRole('button', { name: 'Place bid' }));
    await waitFor(() => {
      expect(screen.getByText('Bid placed on task_001.')).toBeInTheDocument();
    });
  });

  it('shows "Placing bid\u2026" during bid submission', async () => {
    let resolveBid!: (v: unknown) => void;
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/bids' && opts?.method === 'POST') {
        return new Promise((r) => { resolveBid = r; });
      }
      return Promise.resolve(statusAndFreshness);
    });

    const user = userEvent.setup();
    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);

    await user.click(screen.getByRole('button', { name: 'Place bid' }));
    expect(await screen.findByRole('button', { name: /placing bid/i })).toBeInTheDocument();

    resolveBid({});
  });

  it('shows error when bid fails', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/bids' && opts?.method === 'POST') {
        return Promise.reject(new Error('BID_FAILED: insufficient trust tier'));
      }
      return Promise.resolve(statusAndFreshness);
    });

    const user = userEvent.setup();
    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);

    await user.click(screen.getByRole('button', { name: 'Place bid' }));
    await waitFor(() => {
      expect(screen.getByText('BID_FAILED: insufficient trust tier')).toBeInTheDocument();
    });
  });
});

describe('WorkerPage — Reserve and heartbeat flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquires a lease after Reserve lease click', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/reserve' && opts?.method === 'POST') {
        return Promise.resolve({ leaseId: 'lease_abc', leaseToken: 'tok_abc', expiresAt: '2026-03-02T00:02:00Z' });
      }
      return Promise.resolve(statusAndFreshness);
    });

    const user = userEvent.setup();
    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);

    await user.click(screen.getByRole('button', { name: 'Reserve lease' }));
    await waitFor(() => {
      expect(screen.getByText('Lease lease_abc acquired.')).toBeInTheDocument();
    });
  });

  it('enables Heartbeat button after lease is acquired', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/reserve' && opts?.method === 'POST') {
        return Promise.resolve({ leaseId: 'lease_abc', leaseToken: 'tok_abc', expiresAt: '2026-03-02T00:02:00Z' });
      }
      return Promise.resolve(statusAndFreshness);
    });

    const user = userEvent.setup();
    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);

    await user.click(screen.getByRole('button', { name: 'Reserve lease' }));
    await waitFor(() => {
      // After lease acquired, aria-label = 'Send heartbeat for lease lease_abc'
      expect(screen.getByRole('button', { name: /send heartbeat for lease/i })).not.toBeDisabled();
    });
  });

  it('sends heartbeat with leaseId and leaseToken', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/reserve' && opts?.method === 'POST') {
        return Promise.resolve({ leaseId: 'lease_abc', leaseToken: 'tok_abc', expiresAt: '2026-03-02T00:02:00Z' });
      }
      if (path === 'tasks/task_001/heartbeat' && opts?.method === 'POST') {
        return Promise.resolve({ expiresAt: '2026-03-02T00:04:00Z' });
      }
      return Promise.resolve(statusAndFreshness);
    });

    const user = userEvent.setup();
    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);

    await user.click(screen.getByRole('button', { name: 'Reserve lease' }));
    await screen.findByText('Lease lease_abc acquired.');

    // After lease acquired, aria-label changes to 'Send heartbeat for lease lease_abc'
    await user.click(screen.getByRole('button', { name: /send heartbeat for lease/i }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'tasks/task_001/heartbeat',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});

describe('WorkerPage — Scope + Vault flow', () => {
  const leaseResponse = { leaseId: 'lease_abc', leaseToken: 'tok_abc', expiresAt: '2026-03-02T00:02:00Z' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupWithLease(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/reserve' && opts?.method === 'POST') return Promise.resolve(leaseResponse);
      return Promise.resolve(statusAndFreshness);
    });

    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);
    await user.click(screen.getByRole('button', { name: 'Reserve lease' }));
    await screen.findByText('Lease lease_abc acquired.');
  }

  it('enables Fetch scoped manifest after lease acquired', async () => {
    const user = userEvent.setup();
    await setupWithLease(user);
    // aria-label: "Fetch the scoped manifest for the active lease"
    expect(screen.getByRole('button', { name: /fetch.*scoped/i })).not.toBeDisabled();
  });

  it('fetches scope and displays it', async () => {
    const scopeManifest = {
      scopeManifestId: 'scope_001',
      allowedDataRefs: ['dataset://tenant-alpha/input.csv'],
      allowedTools: ['python'],
      egressAllowlist: ['api.tenant.local'],
      classification: 'internal'
    };

    const user = userEvent.setup();
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/reserve' && opts?.method === 'POST') return Promise.resolve(leaseResponse);
      if (path.startsWith('tasks/task_001/scope')) return Promise.resolve(scopeManifest);
      return Promise.resolve(statusAndFreshness);
    });

    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);
    await user.click(screen.getByRole('button', { name: 'Reserve lease' }));
    await screen.findByText('Lease lease_abc acquired.');

    // aria-label: "Fetch the scoped manifest for the active lease"
    await user.click(screen.getByRole('button', { name: /fetch.*scoped/i }));
    await waitFor(() => {
      expect(screen.getByText('python')).toBeInTheDocument();
      expect(screen.getByText('dataset://tenant-alpha/input.csv')).toBeInTheDocument();
    });
  });

  it('issues vault token after scope is fetched', async () => {
    const scopeManifest = {
      scopeManifestId: 'scope_001',
      allowedDataRefs: ['dataset://tenant-alpha/input.csv'],
      allowedTools: ['python'],
      egressAllowlist: [],
      classification: 'internal'
    };
    const vaultToken = 'vault_tok_xyz';

    const user = userEvent.setup();
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks/public') return Promise.resolve({ tasks });
      if (path.startsWith('worker/eligibility')) return Promise.resolve(eligibility);
      if (path === 'tasks/task_001/reserve' && opts?.method === 'POST') return Promise.resolve(leaseResponse);
      if (path.startsWith('tasks/task_001/scope')) return Promise.resolve(scopeManifest);
      if (path === 'tasks/task_001/vault-token' && opts?.method === 'POST') return Promise.resolve({ token: vaultToken });
      return Promise.resolve(statusAndFreshness);
    });

    render(<WorkerPage />);
    await screen.findByText(/Dataset Cleanup/);
    await user.click(screen.getByRole('button', { name: 'Reserve lease' }));
    await screen.findByText('Lease lease_abc acquired.');

    await user.click(screen.getByRole('button', { name: /fetch.*scoped/i }));
    await screen.findByText('python');

    // aria-label: "Mint a vault token for the first allowed data reference"
    await user.click(screen.getByRole('button', { name: /mint.*vault/i }));
    await waitFor(() => {
      // Token value is displayed directly in the callout div
      expect(screen.getByText('vault_tok_xyz')).toBeInTheDocument();
    });
  });
});

describe('WorkerPage — Evidence rail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultLoad();
  });

  it('renders "Worker Evidence Rail" in the evidence panel', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      expect(screen.getAllByText('Worker Evidence Rail').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays trust tier in evidence items', async () => {
    render(<WorkerPage />);
    await waitFor(() => {
      expect(screen.getAllByText('A').length).toBeGreaterThanOrEqual(1);
    });
  });
});
