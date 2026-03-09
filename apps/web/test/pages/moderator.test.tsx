import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../test-utils';
import userEvent from '@testing-library/user-event';
import ModeratorPage from '../../app/moderator/page';

// ─── Mock external dependencies ───────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  usePathname: vi.fn().mockReturnValue('/moderator')
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

const disputeEvents = [
  { eventType: 'dispute.opened', entityId: 'dispute_001', timestamp: '2026-03-02T00:00:00Z' },
  { eventType: 'dispute.evidence_submitted', entityId: 'dispute_001', timestamp: '2026-03-02T00:01:00Z' },
  { eventType: 'dispute.opened', entityId: 'dispute_002', timestamp: '2026-03-02T00:02:00Z' }
];

const allEvents = {
  events: [
    { eventType: 'task.created', entityId: 'task_001', timestamp: '2026-03-02T00:00:00Z' },
    ...disputeEvents
  ]
};

const evidencePayload = {
  dispute: {
    disputeId: 'dispute_001',
    contractId: 'contract_001',
    status: 'OPEN',
    reasonCode: 'NON_DELIVERY',
    appealDeadlineAt: '2026-03-05T00:00:00Z',
    finalRuling: undefined
  },
  evidencePack: { evidencePackId: 'ep_001' },
  artifacts: [
    { artifactId: 'art_001', validationStatus: 'VALID' }
  ],
  events: [
    { eventType: 'dispute.opened', entityId: 'dispute_001', timestamp: '2026-03-02T00:00:00Z' }
  ],
  policyDecisions: [
    { decisionId: 'dec_001', action: 'dispute.resolve', allow: true }
  ]
};

const freshnessStatus = {
  freshness: {
    needsReverifyPrompt: false,
    expired: false,
    secondsToExpiry: 600,
    trustTier: 'A' as const
  }
};

describe('ModeratorPage — Initial render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bffFetch).mockResolvedValue(freshnessStatus);
  });

  it('renders the Moderator Console title', async () => {
    render(<ModeratorPage />);
    expect(screen.getByText('Moderator Console')).toBeInTheDocument();
  });

  it('renders the subtitle', async () => {
    render(<ModeratorPage />);
    expect(screen.getByText(/SLA-prioritized dispute queue/)).toBeInTheDocument();
  });

  it('renders "Dispute Queue" badge', async () => {
    render(<ModeratorPage />);
    expect(screen.getByText('Dispute Queue')).toBeInTheDocument();
  });

  it('renders "Evidence First" badge', async () => {
    render(<ModeratorPage />);
    expect(screen.getByText('Evidence First')).toBeInTheDocument();
  });

  it('renders Load queue button', async () => {
    render(<ModeratorPage />);
    expect(screen.getByRole('button', { name: 'Load queue' })).toBeInTheDocument();
  });

  it('renders Load evidence button (disabled without disputeId)', async () => {
    render(<ModeratorPage />);
    expect(screen.getByRole('button', { name: 'Load evidence' })).toBeDisabled();
  });

  it('renders Finalize ruling button (disabled without disputeId and targetAgentId)', async () => {
    render(<ModeratorPage />);
    expect(screen.getByRole('button', { name: 'Finalize the ruling for this dispute' })).toBeDisabled();
  });

  it('renders Dispute ID input field', async () => {
    render(<ModeratorPage />);
    expect(screen.getByPlaceholderText('dispute_...')).toBeInTheDocument();
  });

  it('renders Target agent input field', async () => {
    render(<ModeratorPage />);
    expect(screen.getByPlaceholderText('agent_...')).toBeInTheDocument();
  });

  it('renders ruling select with three options', async () => {
    render(<ModeratorPage />);
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    const values = options.map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain('refund_requester');
    expect(values).toContain('pay_worker');
    expect(values).toContain('split');
  });

  it('does NOT show queue rows initially (queueLoaded gate)', async () => {
    render(<ModeratorPage />);
    // Queue list only shows items after a load completes
    expect(screen.queryByRole('list', { name: 'Dispute queue' })).toBeNull();
  });

  it('shows "Load an evidence pack..." placeholder text', async () => {
    render(<ModeratorPage />);
    expect(screen.getByText(/Load an evidence pack to review/)).toBeInTheDocument();
  });
});

describe('ModeratorPage — Load queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'events') return Promise.resolve(allEvents);
      return Promise.resolve(freshnessStatus);
    });
  });

  it('calls GET events on load queue click', async () => {
    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.click(screen.getByRole('button', { name: 'Load queue' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('events');
    });
  });

  it('shows dispute events in queue after loading', async () => {
    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.click(screen.getByRole('button', { name: 'Load queue' }));
    await waitFor(() => {
      expect(screen.getAllByText('dispute.opened').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('dispute.evidence_submitted')).toBeInTheDocument();
    });
  });

  it('does NOT show non-dispute events in queue', async () => {
    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.click(screen.getByRole('button', { name: 'Load queue' }));
    await waitFor(() => {
      // task.created should be filtered out
      expect(screen.queryByText('task.created')).toBeNull();
    });
  });

  it('shows "Loading queue\u2026" during loading', async () => {
    let resolveQueue!: (v: unknown) => void;
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'events') {
        return new Promise((r) => { resolveQueue = r; });
      }
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.click(screen.getByRole('button', { name: 'Load queue' }));
    expect(await screen.findByRole('button', { name: /loading queue/i })).toBeInTheDocument();

    resolveQueue(allEvents);
  });

  it('auto-selects the first opened dispute entityId', async () => {
    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.click(screen.getByRole('button', { name: 'Load queue' }));
    await waitFor(() => {
      // Queue is reversed (newest first), so dispute_002 is first in the reversed queue
      // But the auto-select finds the first 'dispute.opened' event in the reversed list
      const input = screen.getByPlaceholderText('dispute_...');
      expect((input as HTMLInputElement).value).toBeTruthy();
    });
  });

  it('clicking a queue item sets the disputeId input', async () => {
    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.click(screen.getByRole('button', { name: 'Load queue' }));

    // Wait for queue items to render as listitem buttons
    let queueButtons: HTMLElement[] = [];
    await waitFor(() => {
      queueButtons = screen.getAllByRole('listitem');
      expect(queueButtons.length).toBeGreaterThanOrEqual(1);
    });

    // Click the last queue item to select it
    await user.click(queueButtons[queueButtons.length - 1]);

    const input = screen.getByPlaceholderText('dispute_...');
    expect((input as HTMLInputElement).value).toBeTruthy();
  });

  it('shows "No disputes in queue." after empty queue loads', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'events') return Promise.resolve({ events: [] });
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.click(screen.getByRole('button', { name: 'Load queue' }));
    await waitFor(() => {
      expect(screen.getByText('No disputes in queue.')).toBeInTheDocument();
    });
  });

  it('shows error when queue load fails', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'events') {
        return Promise.reject(new Error('EVENTS_ERROR: audit log unavailable'));
      }
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.click(screen.getByRole('button', { name: 'Load queue' }));
    await waitFor(() => {
      expect(screen.getByText('EVENTS_ERROR: audit log unavailable')).toBeInTheDocument();
    });
  });
});

describe('ModeratorPage — Load evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables Load evidence button once disputeId is entered', async () => {
    vi.mocked(bffFetch).mockResolvedValue(freshnessStatus);
    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    expect(screen.getByRole('button', { name: 'Load evidence' })).not.toBeDisabled();
  });

  it('calls GET disputes/{id}/evidence', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'disputes/dispute_001/evidence') return Promise.resolve(evidencePayload);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.click(screen.getByRole('button', { name: 'Load evidence' }));

    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith('disputes/dispute_001/evidence');
    });
  });

  it('displays dispute status after loading evidence', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'disputes/dispute_001/evidence') return Promise.resolve(evidencePayload);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.click(screen.getByRole('button', { name: 'Load evidence' }));

    await waitFor(() => {
      // OPEN appears in both the kv-grid content and the evidence rail sidebar
      expect(screen.getAllByText('OPEN').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('NON_DELIVERY')).toBeInTheDocument();
    });
  });

  it('shows "Evidence loaded for ..." message', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path === 'disputes/dispute_001/evidence') return Promise.resolve(evidencePayload);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.click(screen.getByRole('button', { name: 'Load evidence' }));

    await waitFor(() => {
      expect(screen.getByText('Evidence loaded for dispute_001.')).toBeInTheDocument();
    });
  });

  it('shows error when evidence load fails', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string) => {
      if (path.startsWith('disputes/')) {
        return Promise.reject(new Error('EVIDENCE_ERROR: dispute not found'));
      }
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.click(screen.getByRole('button', { name: 'Load evidence' }));

    await waitFor(() => {
      expect(screen.getByText('EVIDENCE_ERROR: dispute not found')).toBeInTheDocument();
    });
  });
});

describe('ModeratorPage — Resolve dispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables Finalize ruling when disputeId and targetAgentId are filled', async () => {
    vi.mocked(bffFetch).mockResolvedValue(freshnessStatus);
    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_A');

    expect(screen.getByRole('button', { name: 'Finalize the ruling for this dispute' })).not.toBeDisabled();
  });

  it('calls POST disputes/{id}/resolve with ruling and targetAgentId', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'disputes/dispute_001/resolve' && opts?.method === 'POST') return Promise.resolve({});
      if (path === 'disputes/dispute_001/evidence') return Promise.resolve(evidencePayload);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_A');

    await user.click(screen.getByRole('button', { name: 'Finalize the ruling for this dispute' }));
    await waitFor(() => {
      expect(vi.mocked(bffFetch)).toHaveBeenCalledWith(
        'disputes/dispute_001/resolve',
        expect.objectContaining({ method: 'POST' })
      );
      const body = JSON.parse(
        (vi.mocked(bffFetch).mock.calls.find((c) => c[0] === 'disputes/dispute_001/resolve')![1] as RequestInit).body as string
      );
      expect(body.ruling).toBe('refund_requester');
      expect(body.targetAgentId).toBe('agent_worker_A');
    });
  });

  it('shows "Dispute resolved with ruling ..." message (with quotes around ruling)', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'disputes/dispute_001/resolve' && opts?.method === 'POST') return Promise.resolve({});
      if (path === 'disputes/dispute_001/evidence') return Promise.resolve(evidencePayload);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_A');

    await user.click(screen.getByRole('button', { name: 'Finalize the ruling for this dispute' }));
    await waitFor(() => {
      expect(screen.getByText(/Dispute dispute_001 resolved with ruling/)).toBeInTheDocument();
      expect(screen.getByText(/refund_requester/)).toBeInTheDocument();
    });
  });

  it('can switch ruling to pay_worker', async () => {
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'disputes/dispute_001/resolve' && opts?.method === 'POST') return Promise.resolve({});
      if (path === 'disputes/dispute_001/evidence') return Promise.resolve(evidencePayload);
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_A');
    await user.selectOptions(screen.getByRole('combobox'), 'pay_worker');

    await user.click(screen.getByRole('button', { name: 'Finalize the ruling for this dispute' }));
    await waitFor(() => {
      const body = JSON.parse(
        (vi.mocked(bffFetch).mock.calls.find((c) => c[0] === 'disputes/dispute_001/resolve')![1] as RequestInit).body as string
      );
      expect(body.ruling).toBe('pay_worker');
    });
  });

  it('shows "Resolving\u2026" during resolve', async () => {
    let resolveDispute!: (v: unknown) => void;
    vi.mocked(bffFetch).mockImplementation((path: string, opts?: RequestInit) => {
      if (path === 'disputes/dispute_001/resolve' && opts?.method === 'POST') {
        return new Promise((r) => { resolveDispute = r; });
      }
      return Promise.resolve(freshnessStatus);
    });

    const user = userEvent.setup();
    render(<ModeratorPage />);

    await user.type(screen.getByPlaceholderText('dispute_...'), 'dispute_001');
    await user.type(screen.getByPlaceholderText('agent_...'), 'agent_worker_A');
    await user.click(screen.getByRole('button', { name: 'Finalize the ruling for this dispute' }));

    expect(await screen.findByRole('button', { name: /resolving/i })).toBeInTheDocument();
    resolveDispute({});
  });
});
