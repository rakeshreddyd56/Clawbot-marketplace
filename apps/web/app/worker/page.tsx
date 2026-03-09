'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConsoleShell } from '../../components/console-shell';
import { EvidenceRail } from '../../components/evidence-rail';
import type { EvidenceItem } from '../../components/evidence-rail';
import { IdentityStrip } from '../../components/identity-strip';
import { RealtimeFeed } from '../../components/realtime-feed';
import { SkeletonCard, SkeletonList } from '../../components/skeleton';
import { TrustTierCard } from '../../components/trust-tier-card';
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
  const [messageIsError, setMessageIsError] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [bidRateError, setBidRateError] = useState('');

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

  const loadState = useCallback(async (clearMessage = true) => {
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
      if (clearMessage) setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load worker data.');
      setMessageIsError(true);
    } finally {
      setInitialLoading(false);
    }
  }, [selectedTaskId]);

  useEffect(() => {
    void loadState();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function validateBidRate(): boolean {
    if (!bidRate || bidRate <= 0) {
      setBidRateError('Bid rate must be greater than 0.');
      return false;
    }
    setBidRateError('');
    return true;
  }

  const placeBid = useCallback(async () => {
    if (!selectedTaskId) return;
    if (!validateBidRate()) return;
    try {
      setLoading('bid');
      await bffFetch(`tasks/${selectedTaskId}/bids`, {
        method: 'POST',
        body: JSON.stringify({ rate: bidRate })
      });
      setMessage(`Bid placed on ${selectedTaskId}.`);
      setMessageIsError(false);
      await loadState(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Bid failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [selectedTaskId, bidRate, loadState]); // eslint-disable-line react-hooks/exhaustive-deps

  const reserveTask = useCallback(async () => {
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
      setMessageIsError(false);
      await loadState(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Reserve failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [selectedTaskId, loadState]);

  const heartbeat = useCallback(async () => {
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
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Heartbeat failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [lease]);

  const loadScope = useCallback(async () => {
    if (!lease) return;
    try {
      setLoading('scope');
      const loaded = await bffFetch<ScopeManifest>(
        `tasks/${lease.taskId}/scope?leaseId=${encodeURIComponent(lease.leaseId)}&leaseToken=${encodeURIComponent(lease.leaseToken)}`
      );
      setScope(loaded);
      setMessage(`Scope fetched with ${loaded.allowedDataRefs.length} data refs.`);
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Scope fetch failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [lease]);

  const issueVaultToken = useCallback(async () => {
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
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Vault token request failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [lease, scope]);

  return (
    <ConsoleShell
      title="Worker Console"
      subtitle="Bid, reserve, heartbeat, scope, and vault flow aligned to Moltbook trust tiers."
      rail={<EvidenceRail title="Worker Evidence Rail" items={evidenceItems} />}
    >
      <section className="stack" aria-label="Worker controls">
        <IdentityStrip leaseExpiresAt={lease?.expiresAt} />

        <TrustTierCard />

        {initialLoading ? (
          <>
            <SkeletonCard rows={4} />
            <SkeletonList count={3} />
          </>
        ) : (
          <div className="card">
            <h2 className="badge">Opportunities</h2>
            <div className="field-grid" style={{ marginTop: 10 }}>
              {tasks.length === 0 ? (
                <div className="empty-state" role="status" style={{ textAlign: 'left' }}>
                  No opportunities available.
                  <div className="muted-text" style={{ marginTop: 4, fontSize: 13 }}>
                    Tasks will appear here once posted to the marketplace.
                  </div>
                </div>
              ) : (
                <label htmlFor="worker-task-select">
                  <span>Task</span>
                  <select
                    id="worker-task-select"
                    value={selectedTaskId}
                    onChange={(event) => setSelectedTaskId(event.target.value)}
                    aria-label="Select a task to bid on"
                  >
                    {tasks.map((task) => (
                      <option key={task.taskId} value={task.taskId}>
                        {task.title} · {task.budget} credits · {task.status}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label htmlFor="bid-rate">
                <span>Bid rate (credits/hr)</span>
                <input
                  id="bid-rate"
                  type="number"
                  min={1}
                  value={bidRate}
                  onChange={(event) => {
                    setBidRate(Number(event.target.value || '1'));
                    if (bidRateError) setBidRateError('');
                  }}
                  onBlur={validateBidRate}
                  aria-describedby={bidRateError ? 'bid-rate-error' : undefined}
                  aria-invalid={bidRateError ? 'true' : 'false'}
                />
                {bidRateError ? (
                  <p id="bid-rate-error" className="field-error" role="alert">
                    {bidRateError}
                  </p>
                ) : null}
              </label>
            </div>
            <div className="button-row">
              <button type="button" onClick={() => void placeBid()} disabled={loading !== null || !selectedTaskId}>
                {loading === 'bid' ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Placing bid…
                  </>
                ) : (
                  'Place bid'
                )}
              </button>
              <button type="button" onClick={() => void reserveTask()} disabled={loading !== null || !selectedTaskId}>
                {loading === 'reserve' ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Reserving…
                  </>
                ) : (
                  'Reserve lease'
                )}
              </button>
              <button
                type="button"
                onClick={() => void heartbeat()}
                disabled={loading !== null || !lease}
                aria-label={lease ? `Send heartbeat for lease ${lease.leaseId}` : 'Heartbeat (requires active lease)'}
              >
                {loading === 'heartbeat' ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  'Heartbeat'
                )}
              </button>
            </div>
            {eligibility ? (
              <p className="muted-text" role="status" style={{ marginTop: 8 }}>
                Eligibility — bid: {eligibility.canBid ? 'yes' : 'no'} · reserve: {eligibility.canReserve ? 'yes' : 'no'} · payout:{' '}
                {eligibility.canPayout ? 'yes' : 'no'}
              </p>
            ) : null}
          </div>
        )}

        <div className="card">
          <h2 className="badge">Scope + Vault</h2>
          <div className="button-row" style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => void loadScope()}
              disabled={loading !== null || !lease}
              aria-label="Fetch the scoped manifest for the active lease"
            >
              {loading === 'scope' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Loading…
                </>
              ) : (
                'Fetch scoped manifest'
              )}
            </button>
            <button
              type="button"
              onClick={() => void issueVaultToken()}
              disabled={loading !== null || !scope || !lease}
              aria-label="Mint a vault token for the first allowed data reference"
            >
              {loading === 'vault' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Issuing…
                </>
              ) : (
                'Mint vault token'
              )}
            </button>
          </div>

          {scope ? (
            <div className="kv-grid" style={{ marginTop: 10 }}>
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
          {vaultToken ? (
            <div className="callout ok" style={{ marginTop: 10 }}>
              <strong>Vault token issued</strong>
              <div className="muted-text" style={{ marginTop: 4, wordBreak: 'break-all', fontSize: 12 }}>
                {vaultToken}
              </div>
            </div>
          ) : null}
        </div>

        <RealtimeFeed channels={['task.*', 'contract.*', 'sanction.*']} />

        {message ? (
          <div className={`callout ${messageIsError ? 'bad' : 'ok'}`} role="alert" aria-live="assertive">
            {message}
          </div>
        ) : null}
      </section>
    </ConsoleShell>
  );
}
