'use client';

import { useEffect, useMemo, useState } from 'react';
import { ConsoleShell } from '../../components/console-shell';
import { EvidenceRail } from '../../components/evidence-rail';
import type { EvidenceItem } from '../../components/evidence-rail';
import { IdentityStrip } from '../../components/identity-strip';
import { RealtimeFeed } from '../../components/realtime-feed';
import { bffFetch } from '../../components/api';

type TaskCard = {
  taskId: string;
  title: string;
  pricingMode: 'fixed' | 'hourly';
  budget: number;
  deadlineAt: string;
  status: string;
};

type WorkerEligibility = {
  trustTier: 'A' | 'B' | 'C';
  canBid: boolean;
  canReserve: boolean;
  canPayout: boolean;
  payoutDelayHours: number;
  blockReasons: Array<{ code: string; message: string }>;
};

type Lease = {
  taskId: string;
  leaseId: string;
  leaseToken: string;
  expiresAt: string;
};

type ScopeManifest = {
  scopeManifestId: string;
  allowedDataRefs: string[];
  allowedTools: string[];
  egressAllowlist: string[];
  classification: string;
};

export default function WorkerPage() {
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [eligibility, setEligibility] = useState<WorkerEligibility | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [bidRate, setBidRate] = useState(50);
  const [lease, setLease] = useState<Lease | null>(null);
  const [scope, setScope] = useState<ScopeManifest | null>(null);
  const [vaultToken, setVaultToken] = useState<string>('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

  const evidenceItems = useMemo<EvidenceItem[]>(
    () => [
      { label: 'Trust tier', value: eligibility?.trustTier ?? 'unknown', tone: eligibility?.trustTier === 'A' ? 'ok' : eligibility?.trustTier === 'B' ? 'warn' : 'bad' },
      { label: 'Selected task', value: selectedTaskId || 'none', tone: selectedTaskId ? 'info' : 'warn' },
      { label: 'Lease', value: lease?.leaseId ?? 'none', tone: lease ? 'ok' : 'warn' },
      { label: 'Scope class', value: scope?.classification ?? 'none', tone: scope ? 'ok' : 'warn' },
      { label: 'Vault token', value: vaultToken ? 'issued' : 'none', tone: vaultToken ? 'ok' : 'warn' }
    ],
    [eligibility?.trustTier, lease, scope, selectedTaskId, vaultToken]
  );

  async function loadState() {
    try {
      const [taskResponse, workerEligibility] = await Promise.all([
        bffFetch<{ tasks: TaskCard[] }>('tasks/public'),
        bffFetch<WorkerEligibility>('worker/eligibility')
      ]);

      setTasks(taskResponse.tasks);
      setEligibility(workerEligibility);
      if (!selectedTaskId && taskResponse.tasks.length > 0) {
        setSelectedTaskId(taskResponse.tasks[0].taskId);
      }
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load worker data.');
    }
  }

  useEffect(() => {
    void loadState();
  }, []);

  async function placeBid() {
    if (!selectedTaskId) return;
    try {
      setLoading('bid');
      await bffFetch(`tasks/${selectedTaskId}/bids`, {
        method: 'POST',
        body: JSON.stringify({ rate: bidRate })
      });
      setMessage(`Bid placed on ${selectedTaskId}.`);
      await loadState();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Bid failed.');
    } finally {
      setLoading(null);
    }
  }

  async function reserveTask() {
    if (!selectedTaskId) return;
    try {
      setLoading('reserve');
      const reserved = await bffFetch<{ leaseId: string; leaseToken: string; expiresAt: string }>(`tasks/${selectedTaskId}/reserve`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      setLease({
        taskId: selectedTaskId,
        leaseId: reserved.leaseId,
        leaseToken: reserved.leaseToken,
        expiresAt: reserved.expiresAt
      });
      setMessage(`Lease ${reserved.leaseId} acquired.`);
      await loadState();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Reserve failed.');
    } finally {
      setLoading(null);
    }
  }

  async function heartbeat() {
    if (!lease) return;
    try {
      setLoading('heartbeat');
      const beat = await bffFetch<{ expiresAt: string }>(`tasks/${lease.taskId}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({
          leaseId: lease.leaseId,
          leaseToken: lease.leaseToken
        })
      });
      setLease({ ...lease, expiresAt: beat.expiresAt });
      setMessage(`Lease heartbeat accepted until ${new Date(beat.expiresAt).toLocaleTimeString()}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Heartbeat failed.');
    } finally {
      setLoading(null);
    }
  }

  async function loadScope() {
    if (!lease) return;
    try {
      setLoading('scope');
      const loaded = await bffFetch<ScopeManifest>(
        `tasks/${lease.taskId}/scope?leaseId=${encodeURIComponent(lease.leaseId)}&leaseToken=${encodeURIComponent(lease.leaseToken)}`
      );
      setScope(loaded);
      setMessage(`Scope fetched with ${loaded.allowedDataRefs.length} data refs.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Scope fetch failed.');
    } finally {
      setLoading(null);
    }
  }

  async function issueVaultToken() {
    if (!lease || !scope || scope.allowedDataRefs.length === 0) return;
    try {
      setLoading('vault');
      const response = await bffFetch<{ token: string }>(`tasks/${lease.taskId}/vault-token`, {
        method: 'POST',
        body: JSON.stringify({
          leaseId: lease.leaseId,
          leaseToken: lease.leaseToken,
          dataRef: scope.allowedDataRefs[0]
        })
      });
      setVaultToken(response.token);
      setMessage('Per-task vault token issued for first allowed data reference.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Vault token request failed.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <ConsoleShell
      title="Worker Console"
      subtitle="Bid, reserve, heartbeat, scope, and vault flow aligned to Moltbook trust tiers."
      rail={<EvidenceRail title="Worker Evidence Rail" items={evidenceItems} />}
    >
      <section className="stack">
        <IdentityStrip leaseExpiresAt={lease?.expiresAt} />

        <div className="card">
          <div className="badge">Opportunities</div>
          <div className="field-grid">
            <label>
              <span>Task</span>
              <select value={selectedTaskId} onChange={(event) => setSelectedTaskId(event.target.value)}>
                {tasks.length === 0 ? <option value="">No posted tasks</option> : null}
                {tasks.map((task) => (
                  <option key={task.taskId} value={task.taskId}>
                    {task.title} · {task.budget} credits · {task.status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Bid rate</span>
              <input type="number" min={1} value={bidRate} onChange={(event) => setBidRate(Number(event.target.value || '1'))} />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={placeBid} disabled={loading !== null || !selectedTaskId}>
              {loading === 'bid' ? 'Placing bid...' : 'Place bid'}
            </button>
            <button type="button" onClick={reserveTask} disabled={loading !== null || !selectedTaskId}>
              {loading === 'reserve' ? 'Reserving...' : 'Reserve lease'}
            </button>
            <button type="button" onClick={heartbeat} disabled={loading !== null || !lease}>
              {loading === 'heartbeat' ? 'Sending...' : 'Heartbeat'}
            </button>
          </div>
          {eligibility ? (
            <p className="muted-text">
              Eligibility: bid={String(eligibility.canBid)} reserve={String(eligibility.canReserve)} payout={String(eligibility.canPayout)}
            </p>
          ) : null}
        </div>

        <div className="card">
          <div className="badge">Scope + Vault</div>
          <div className="button-row">
            <button type="button" onClick={loadScope} disabled={loading !== null || !lease}>
              {loading === 'scope' ? 'Loading...' : 'Fetch scoped manifest'}
            </button>
            <button type="button" onClick={issueVaultToken} disabled={loading !== null || !scope || !lease}>
              {loading === 'vault' ? 'Issuing...' : 'Mint vault token'}
            </button>
          </div>

          {scope ? (
            <div className="kv-grid">
              <div>
                <strong>Tools</strong>
                <div>{scope.allowedTools.join(', ')}</div>
              </div>
              <div>
                <strong>Data refs</strong>
                <div>{scope.allowedDataRefs.join(', ')}</div>
              </div>
              <div>
                <strong>Egress allowlist</strong>
                <div>{scope.egressAllowlist.join(', ') || 'none'}</div>
              </div>
            </div>
          ) : (
            <p className="muted-text">Scope stays hidden until lease token checks pass.</p>
          )}
          {vaultToken ? <p className="muted-text">Vault token: {vaultToken}</p> : null}
        </div>

        <RealtimeFeed channels={['task.*', 'contract.*', 'sanction.*']} />
        {message ? <div className="card">{message}</div> : null}
      </section>
    </ConsoleShell>
  );
}
