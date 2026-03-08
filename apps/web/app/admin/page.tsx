'use client';

import { useCallback, useMemo, useState } from 'react';
import { ConsoleShell } from '../../components/console-shell';
import { EvidenceRail } from '../../components/evidence-rail';
import type { EvidenceItem } from '../../components/evidence-rail';
import { IdentityStrip } from '../../components/identity-strip';
import { RealtimeFeed } from '../../components/realtime-feed';
import { bffFetch } from '../../components/api';

type PolicyDecision = {
  decisionId: string;
  action: string;
  allow: boolean;
  reason: string;
  policyVersion: string;
};

type WorkerEligibility = {
  trustTier: 'A' | 'B' | 'C';
  canBid: boolean;
  canReserve: boolean;
  canPayout: boolean;
  payoutDelayHours: number;
  blockReasons: Array<{ code: string; message: string }>;
};

type SweepResult = {
  swept: number;
  disputes: Array<{
    disputeId: string;
    status: string;
    finalRuling: string;
    againstAgentId?: string;
  }>;
};

export default function AdminPage() {
  const [agentId, setAgentId] = useState('');
  const [eligibility, setEligibility] = useState<WorkerEligibility | null>(null);
  const [decisions, setDecisions] = useState<PolicyDecision[]>([]);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [decisionsLoaded, setDecisionsLoaded] = useState(false);
  const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);

  const evidenceItems = useMemo<EvidenceItem[]>(
    () => [
      { label: 'Observed decisions', value: String(decisions.length), tone: 'info' },
      { label: 'Queried agent', value: agentId || 'none', tone: agentId ? 'ok' : 'warn' },
      { label: 'Tier', value: eligibility?.trustTier ?? 'n/a', tone: eligibility?.trustTier === 'A' ? 'ok' : eligibility?.trustTier === 'B' ? 'warn' : 'bad' },
      { label: 'Reserve', value: eligibility ? String(eligibility.canReserve) : 'n/a', tone: eligibility?.canReserve ? 'ok' : 'warn' },
      { label: 'Payout', value: eligibility ? String(eligibility.canPayout) : 'n/a', tone: eligibility?.canPayout ? 'ok' : 'warn' }
    ],
    [agentId, decisions.length, eligibility]
  );

  const loadDecisions = useCallback(async () => {
    try {
      setLoading('decisions');
      const payload = await bffFetch<{ decisions: PolicyDecision[] }>('policy/decisions');
      setDecisions(payload.decisions.slice(-50).reverse());
      setDecisionsLoaded(true);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load decisions.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, []);

  const runDisputeSweep = useCallback(async () => {
    try {
      setLoading('sweep');
      const result = await bffFetch<SweepResult>('disputes/sweep', {
        method: 'POST',
        body: JSON.stringify({})
      });
      setSweepResult(result);
      if (result.swept > 0) {
        setMessage(`Swept ${result.swept} expired dispute${result.swept === 1 ? '' : 's'} with auto-ruling.`);
      } else {
        setMessage('No expired disputes found. All disputes are within the 72h response window.');
      }
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Dispute sweep failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, []);

  const loadEligibility = useCallback(async () => {
    if (!agentId) return;
    try {
      setLoading('eligibility');
      const payload = await bffFetch<WorkerEligibility>(`worker/eligibility?agentId=${encodeURIComponent(agentId)}`);
      setEligibility(payload);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load worker eligibility.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [agentId]);

  return (
    <ConsoleShell
      title="Admin Console"
      subtitle="Policy, trust-tier eligibility checks, and operational audit visibility."
      rail={<EvidenceRail title="Admin Evidence Rail" items={evidenceItems} />}
    >
      <section className="stack" aria-label="Admin controls">
        <IdentityStrip />

        <div className="card">
          <h2 className="badge">Worker Eligibility Probe</h2>
          <div className="field-grid" style={{ marginTop: 10 }}>
            <label htmlFor="admin-agent-id">
              <span>Agent ID</span>
              <input
                id="admin-agent-id"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                placeholder="agent_..."
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void loadEligibility();
                }}
              />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void loadEligibility()} disabled={loading !== null || !agentId}>
              {loading === 'eligibility' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Checking…
                </>
              ) : (
                'Check eligibility'
              )}
            </button>
          </div>
          {eligibility ? (
            <div className="kv-grid" style={{ marginTop: 10 }}>
              <div>
                <strong>Trust tier</strong>
                <div>{eligibility.trustTier}</div>
              </div>
              <div>
                <strong>Bid</strong>
                <div>{eligibility.canBid ? 'Allowed' : 'Blocked'}</div>
              </div>
              <div>
                <strong>Reserve</strong>
                <div>{eligibility.canReserve ? 'Allowed' : 'Blocked'}</div>
              </div>
              <div>
                <strong>Payout</strong>
                <div>{eligibility.canPayout ? 'Allowed' : 'Blocked'}</div>
              </div>
            </div>
          ) : (
            <p className="muted-text" style={{ marginTop: 8 }}>
              Enter an agent ID to inspect tier-derived worker rights.
            </p>
          )}
        </div>

        <div className="card">
          <h2 className="badge">Policy Decisions</h2>
          <div className="button-row" style={{ marginTop: 10 }}>
            <button type="button" onClick={() => void loadDecisions()} disabled={loading !== null}>
              {loading === 'decisions' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Loading…
                </>
              ) : (
                'Load policy log'
              )}
            </button>
          </div>
          {decisionsLoaded && decisions.length === 0 ? (
            <div className="empty-state" role="status" style={{ textAlign: 'left', paddingLeft: 0 }}>
              No policy decisions recorded.
              <div className="muted-text" style={{ marginTop: 4, fontSize: 13 }}>
                Policy decisions will appear here as agents perform actions.
              </div>
            </div>
          ) : decisions.length > 0 ? (
            <div className="stack-tight" style={{ marginTop: 10 }} role="list" aria-label="Policy decision log">
              {decisions.map((decision) => (
                <div key={decision.decisionId} className="readiness-row" role="listitem">
                  <div>
                    <strong>{decision.action}</strong>
                    <div className="muted-text" style={{ fontSize: 12 }}>
                      {decision.decisionId} · {decision.policyVersion}
                    </div>
                  </div>
                  <span
                    className={`pill ${decision.allow ? 'pill-ok' : 'pill-bad'}`}
                    role="status"
                    aria-label={`${decision.action}: ${decision.allow ? 'allowed' : 'denied'}`}
                  >
                    {decision.allow ? 'ALLOW' : 'DENY'}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2 className="badge">Dispute Auto-Ruling Sweep</h2>
          <p className="muted-text" style={{ marginTop: 8, marginBottom: 0 }}>
            Sweep all disputes past the 72-hour response deadline. Expired disputes receive a default ruling
            in favor of the opener, with progressive sanctions applied to non-responding parties.
          </p>
          <div className="button-row" style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => void runDisputeSweep()}
              disabled={loading !== null}
              aria-label="Run dispute auto-ruling sweep for expired 72h deadlines"
            >
              {loading === 'sweep' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Sweeping…
                </>
              ) : (
                'Run sweep'
              )}
            </button>
          </div>
          {sweepResult ? (
            <div className="sweep-results" data-testid="sweep-results">
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <div>
                  <strong>Swept</strong>
                  <div>{sweepResult.swept} dispute{sweepResult.swept === 1 ? '' : 's'}</div>
                </div>
              </div>
              {sweepResult.disputes.length > 0 ? (
                <div className="stack-tight" style={{ marginTop: 10 }} role="list" aria-label="Swept disputes">
                  {sweepResult.disputes.map((d) => (
                    <div key={d.disputeId} className="readiness-row" role="listitem">
                      <div>
                        <strong>{d.disputeId}</strong>
                        <div className="muted-text" style={{ fontSize: 12 }}>
                          Ruling: {d.finalRuling}{d.againstAgentId ? ` | Against: ${d.againstAgentId}` : ''}
                        </div>
                      </div>
                      <span className="pill pill-warn" role="status">
                        {d.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted-text" style={{ marginTop: 8 }}>
                  No disputes required auto-ruling.
                </p>
              )}
            </div>
          ) : null}
        </div>

        <RealtimeFeed channels={['task.*', 'contract.*', 'dispute.*', 'wallet.*', 'sanction.*']} />

        {message ? (
          <div className={`callout ${messageIsError ? 'bad' : 'ok'}`} role="alert" aria-live="assertive">
            {message}
          </div>
        ) : null}
      </section>
    </ConsoleShell>
  );
}
