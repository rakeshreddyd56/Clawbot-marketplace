'use client';

import { useMemo, useState } from 'react';
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

export default function AdminPage() {
  const [agentId, setAgentId] = useState('');
  const [eligibility, setEligibility] = useState<WorkerEligibility | null>(null);
  const [decisions, setDecisions] = useState<PolicyDecision[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

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

  async function loadDecisions() {
    try {
      setLoading('decisions');
      const payload = await bffFetch<{ decisions: PolicyDecision[] }>('policy/decisions');
      setDecisions(payload.decisions.slice(-50).reverse());
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load decisions.');
    } finally {
      setLoading(null);
    }
  }

  async function loadEligibility() {
    if (!agentId) return;
    try {
      setLoading('eligibility');
      const payload = await bffFetch<WorkerEligibility>(`worker/eligibility?agentId=${encodeURIComponent(agentId)}`);
      setEligibility(payload);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load worker eligibility.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <ConsoleShell
      title="Admin Console"
      subtitle="Policy, trust-tier eligibility checks, and operational audit visibility."
      rail={<EvidenceRail title="Admin Evidence Rail" items={evidenceItems} />}
    >
      <section className="stack">
        <IdentityStrip />

        <div className="card">
          <div className="badge">Worker Eligibility Probe</div>
          <div className="field-grid">
            <label>
              <span>Agent ID</span>
              <input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="agent_..." />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={loadEligibility} disabled={loading !== null || !agentId}>
              {loading === 'eligibility' ? 'Checking...' : 'Check eligibility'}
            </button>
          </div>
          {eligibility ? (
            <div className="kv-grid">
              <div>
                <strong>Trust tier</strong>
                <div>{eligibility.trustTier}</div>
              </div>
              <div>
                <strong>Bid</strong>
                <div>{String(eligibility.canBid)}</div>
              </div>
              <div>
                <strong>Reserve</strong>
                <div>{String(eligibility.canReserve)}</div>
              </div>
              <div>
                <strong>Payout</strong>
                <div>{String(eligibility.canPayout)}</div>
              </div>
            </div>
          ) : (
            <p className="muted-text">Enter an agent ID to inspect tier-derived worker rights.</p>
          )}
        </div>

        <div className="card">
          <div className="badge">Policy Decisions</div>
          <div className="button-row">
            <button type="button" onClick={loadDecisions} disabled={loading !== null}>
              {loading === 'decisions' ? 'Loading...' : 'Load policy log'}
            </button>
          </div>
          {decisions.length > 0 ? (
            <div className="stack-tight">
              {decisions.map((decision) => (
                <div key={decision.decisionId} className="readiness-row">
                  <div>
                    <strong>{decision.action}</strong>
                    <div className="muted-text">
                      {decision.decisionId} · {decision.policyVersion}
                    </div>
                  </div>
                  <span className={`pill ${decision.allow ? 'pill-ok' : 'pill-bad'}`}>{decision.allow ? 'ALLOW' : 'DENY'}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-text">No policy decisions loaded.</p>
          )}
        </div>

        <RealtimeFeed channels={['task.*', 'contract.*', 'dispute.*', 'wallet.*', 'sanction.*']} />
        {message ? <div className="card">{message}</div> : null}
      </section>
    </ConsoleShell>
  );
}
