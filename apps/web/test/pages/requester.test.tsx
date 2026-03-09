import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../test-utils';
import userEvent from '@testing-library/user-event';
import RequesterPage from '../../app/requester/page';

// ─── Mock external dependencies ───────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  usePathname: vi.fn().mockReturnValue('/requester')
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
  { taskId: 'task_r01', title: 'Normalization Task', budget: 150, status: 'DRAFT', deadlineAt: '2026-03-03T00:00:00Z' },
  { taskId: 'task_r02', title: 'Aggregation Task', budget: 300, status: 'POSTED', deadlineAt: '2026-03-04T00:00:00Z' }
];

const bids = [
  { bidId: 'bid_001', workerAgentId: 'agent_worker_A', rate: 50 },
  { bidId: 'bid_002', workerAgentId: 'agent_worker_B', rate: 75 }
];

const freshnessStatus = {
  freshness: {
    needsReverifyPrompt: false,
    expired: false,
    secondsToExpiry: 600,
    trustTier: 'A' as const
  }
};

// ─── Path-keyed default mock ───────────────────────────────────────────────────
// Uses mockImplementation so IdentityStrip's concurrent bffFetch('identity/moltbook/status')
// call doesn't consume values intended for page-level actions regardless of effect order.

function mockDefaultLoad() {
  vi.mocked(bffFetch).mockImplementation((path: string) => {
    if (path === 'tasks') return Promise.resolve({ tasks });
    if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
    return Promise.resolve({});
  });
}

// ─── Initial render ────────────────────────────────────────────────────────────

describe('RequesterPage — Initial render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultLoad();
  });

  it('renders the Requester Console title', async () => {
    render(<RequesterPage />);
    expect(screen.getByText('Requester Console')).toBeInTheDocument();
  });

  it('renders the subtitle with key concepts', async () => {
    render(<RequesterPage />);
    expect(screen.getByText(/High-sensitivity task creation/)).toBeInTheDocument();
  });

  it('loads tasks on mount', async () => {
    render(<RequesterPage />);
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('tasks');
    });
  });

  it('renders "Create + Post Task" badge', async () => {
    render(<RequesterPage />);
    expect(screen.getByText('Create + Post Task')).toBeInTheDocument();
  });

  it('renders "Bids + Assignment" badge', async () => {
    render(<RequesterPage />);
    expect(screen.getByText('Bids + Assignment')).toBeInTheDocument();
  });

  it('renders "Dispute Trigger" badge', async () => {
    render(<RequesterPage />);
    expect(screen.getByText('Dispute Trigger')).toBeInTheDocument();
  });

  it('renders task title input pre-filled', async () => {
    render(<RequesterPage />);
    expect(screen.getByDisplayValue('High-sensitivity data transformation')).toBeInTheDocument();
  });

  it('renders budget input with default 120', async () => {
    render(<RequesterPage />);
    expect(screen.getByDisplayValue('120')).toBeInTheDocument();
  });

  it('renders Top up wallet button', async () => {
    render(<RequesterPage />);
    expect(screen.getByRole('button', { name: 'Top up wallet' })).toBeInTheDocument();
  });

  it('renders Create task button', async () => {
    render(<RequesterPage />);
    expect(screen.getByRole('button', { name: 'Create task' })).toBeInTheDocument();
  });

  it('renders Post task button (enabled after tasks load with auto-selected task)', async () => {
    render(<RequesterPage />);
    await waitFor(() => {
      // after tasks load, first task is auto-selected → button enabled
      expect(screen.getByRole('button', { name: 'Post task' })).not.toBeDisabled();
    });
  });

  it('renders Load bids button', async () => {
    render(<RequesterPage />);
    expect(screen.getByRole('button', { name: 'Load bids' })).toBeInTheDocument();
  });

  it('renders Accept lease button (disabled without leaseId/token)', async () => {
    render(<RequesterPage />);
    expect(screen.getByRole('button', { name: 'Accept lease' })).toBeDisabled();
  });

  it('renders Open dispute button (disabled without contractId/agent)', async () => {
    render(<RequesterPage />);
    expect(screen.getByRole('button', { name: 'Open dispute' })).toBeDisabled();
  });

  it('shows "No bids loaded yet." message initially', async () => {
    render(<RequesterPage />);
    // Component renders full sentence with curly quotes — use regex for resilience
    await waitFor(() => {
      expect(screen.getByText(/No bids loaded yet/)).toBeInTheDocument();
    });
  });

  it('displays loaded tasks in task selector', async () => {
    render(<RequesterPage />);
    await waitFor(() => {
      expect(screen.getByText(/Normalization Task/)).toBeInTheDocument();
    });
  });

  it('shows error when initial load fails', async () => {
    vi.clearAllMocks();
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'tasks') return Promise.reject(new Error('LOAD_ERROR: tasks endpoint down'));
      return Promise.resolve(freshnessStatus);
    });

    render(<RequesterPage />);
    await waitFor(() => {
      expect(screen.getByText('LOAD_ERROR: tasks endpoint down')).toBeInTheDocument();
    });
  });
});

// ─── Top up wallet ─────────────────────────────────────────────────────────────

describe('RequesterPage — Top up wallet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls POST wallet/topup with 500 credits', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'wallet/topup' && opts?.method === 'POST') return Promise.resolve({});
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.click(screen.getByRole('button', { name: 'Top up wallet' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'wallet/topup',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ amount: 500 }) })
      );
    });
  });

  it('shows success message after top up', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'wallet/topup' && opts?.method === 'POST') return Promise.resolve({});
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.click(screen.getByRole('button', { name: 'Top up wallet' }));
    await waitFor(() => {
      expect(screen.getByText('Wallet topped up by 500 credits.')).toBeInTheDocument();
    });
  });

  it('shows error when top up fails', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'wallet/topup') return Promise.reject(new Error('INSUFFICIENT_BALANCE: wallet limit reached'));
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.click(screen.getByRole('button', { name: 'Top up wallet' }));
    await waitFor(() => {
      expect(screen.getByText('INSUFFICIENT_BALANCE: wallet limit reached')).toBeInTheDocument();
    });
  });
});

// ─── Create task ───────────────────────────────────────────────────────────────

describe('RequesterPage — Create task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls POST tasks with form data', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks' && opts?.method === 'POST') return Promise.resolve({ taskId: 'task_new_01' });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'tasks',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows task created message', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks' && opts?.method === 'POST') return Promise.resolve({ taskId: 'task_new_01' });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => {
      expect(screen.getByText('Task task_new_01 created.')).toBeInTheDocument();
    });
  });

  it('shows "Creating\u2026" during task creation', async () => {
    let resolveCreate!: (v: unknown) => void;
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'tasks' && opts?.method === 'POST') {
        return new Promise((r) => { resolveCreate = r; });
      }
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.click(screen.getByRole('button', { name: 'Create task' }));
    // Button text changes to "Creating…" (Unicode ellipsis) during in-flight request
    expect(await screen.findByRole('button', { name: /creating/i })).toBeInTheDocument();

    resolveCreate({ taskId: 'task_new_01' });
  });
});

// ─── Load bids and accept lease ────────────────────────────────────────────────

describe('RequesterPage — Load bids and accept lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads bids for selected task', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.endsWith('/bids')) return Promise.resolve({ bids });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);
    await screen.findByText(/Normalization Task/);

    await user.click(screen.getByRole('button', { name: 'Load bids' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('tasks/task_r01/bids');
    });
  });

  it('renders bid rows after loading bids', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.endsWith('/bids')) return Promise.resolve({ bids });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);
    await screen.findByText(/Normalization Task/);

    await user.click(screen.getByRole('button', { name: 'Load bids' }));
    await waitFor(() => {
      expect(screen.getByText('agent_worker_A')).toBeInTheDocument();
      expect(screen.getByText('agent_worker_B')).toBeInTheDocument();
    });
  });

  it('shows bid rate with credits/hr', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.endsWith('/bids')) return Promise.resolve({ bids });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);
    await screen.findByText(/Normalization Task/);

    await user.click(screen.getByRole('button', { name: 'Load bids' }));
    await waitFor(() => {
      expect(screen.getByText('50 credits/hr')).toBeInTheDocument();
    });
  });

  it('enables Accept lease button when leaseId and leaseToken are filled', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    const leaseIdInput = screen.getByPlaceholderText('lease_...');
    const leaseTokenInput = screen.getByPlaceholderText('lease_tok_...');

    await user.type(leaseIdInput, 'lease_abc');
    await user.type(leaseTokenInput, 'lease_tok_xyz');

    expect(screen.getByRole('button', { name: 'Accept lease' })).not.toBeDisabled();
  });

  it('calls POST tasks/{id}/accept with leaseId and leaseToken', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path.endsWith('/accept') && opts?.method === 'POST') return Promise.resolve({ contractId: 'contract_001' });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);
    await screen.findByText(/Normalization Task/);

    const leaseIdInput = screen.getByPlaceholderText('lease_...');
    const leaseTokenInput = screen.getByPlaceholderText('lease_tok_...');

    await user.type(leaseIdInput, 'lease_abc');
    await user.type(leaseTokenInput, 'lease_tok_xyz');
    await user.click(screen.getByRole('button', { name: 'Accept lease' }));

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        expect.stringContaining('/accept'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows contract created message after accept', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path.endsWith('/accept') && opts?.method === 'POST') return Promise.resolve({ contractId: 'contract_001' });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);
    await screen.findByText(/Normalization Task/);

    await user.type(screen.getByPlaceholderText('lease_...'), 'lease_abc');
    await user.type(screen.getByPlaceholderText('lease_tok_...'), 'tok_xyz');
    await user.click(screen.getByRole('button', { name: 'Accept lease' }));

    await waitFor(() => {
      expect(screen.getByText('Contract contract_001 created.')).toBeInTheDocument();
    });
  });
});

// ─── Open dispute ──────────────────────────────────────────────────────────────

describe('RequesterPage — Open dispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables Open dispute button when contractId and disputeAgainst are filled', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.type(screen.getByPlaceholderText('contract_...'), 'contract_xyz');
    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_A');

    expect(screen.getByRole('button', { name: 'Open dispute' })).not.toBeDisabled();
  });

  it('calls POST disputes with correct payload', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'disputes' && opts?.method === 'POST') return Promise.resolve({ disputeId: 'dispute_001' });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.type(screen.getByPlaceholderText('contract_...'), 'contract_xyz');
    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_A');

    await user.click(screen.getByRole('button', { name: 'Open dispute' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'disputes',
        expect.objectContaining({ method: 'POST' })
      );
      const body = JSON.parse(
        (vi.mocked(bffFetch).mock.calls.find((c) => c[0] === 'disputes')![1] as RequestInit).body as string
      );
      expect(body.contractId).toBe('contract_xyz');
      expect(body.againstAgentId).toBe('agent_worker_A');
      expect(body.reasonCode).toBe('NON_DELIVERY');
    });
  });

  it('shows dispute opened message', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'disputes' && opts?.method === 'POST') return Promise.resolve({ disputeId: 'dispute_001' });
      if (path === 'tasks') return Promise.resolve({ tasks });
      if (path === 'identity/moltbook/status') return Promise.resolve(freshnessStatus);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<RequesterPage />);

    await user.type(screen.getByPlaceholderText('contract_...'), 'contract_xyz');
    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_A');
    await user.click(screen.getByRole('button', { name: 'Open dispute' }));

    await waitFor(() => {
      expect(screen.getByText('Dispute dispute_001 opened.')).toBeInTheDocument();
    });
  });
});
