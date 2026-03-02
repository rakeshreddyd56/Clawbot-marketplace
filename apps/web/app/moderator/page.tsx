'use client';

import { useMemo, useState } from 'react';
import { ConsoleShell } from '../../components/console-shell';
import { EvidenceRail } from '../../components/evidence-rail';
import type { EvidenceItem } from '../../components/evidence-rail';
import { IdentityStrip } from '../../components/identity-strip';
import { RealtimeFeed } from '../../components/realtime-feed';
import { bffFetch } from '../../components/api';

type Dispute = {
  disputeId: string;
  contractId: string;
  status: string;
  reasonCode: string;
  appealDeadlineAt: string;
  finalRuling?: string;
};

type EvidencePayload = {
  dispute: Dispute;
  evidencePack: { evidencePackId: string } | null;
  artifacts: Array<{ artifactId: string; validationStatus: string }>;
  events: Array<{ eventType: string; entityId: string; timestamp: string }>;
  policyDecisions: Array<{ decisionId: string; action: string; allow: boolean }>;
};

export default function ModeratorPage() {
  const [disputeId, setDisputeId] = useState('');
  const [targetAgentId, setTargetAgentId] = useState('');
  const [ruling, setRuling] = useState<'pay_worker' | 'refund_requester' | 'split'>('refund_requester');
  const [queue, setQueue] = useState<Array<{ eventType: string; entityId: string; timestamp: string }>>([]);
  const [evidence, setEvidence] = useState<EvidencePayload | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

  const evidenceItems = useMemo<EvidenceItem[]>(
    () => [
      { label: 'Case', value: (evidence?.dispute.disputeId ?? disputeId) || 'none', tone: evidence ? 'ok' : 'warn' },
      { label: 'Status', value: evidence?.dispute.status ?? 'unknown', tone: evidence?.dispute.status === 'FINAL' ? 'ok' : 'warn' },
      { label: 'Evidence pack', value: evidence?.evidencePack?.evidencePackId ?? 'pending', tone: evidence?.evidencePack ? 'ok' : 'warn' },
      { label: 'Artifacts', value: String(evidence?.artifacts.length ?? 0), tone: 'info' },
      { label: 'Policy decisions', value: String(evidence?.policyDecisions.length ?? 0), tone: 'info' }
    ],
    [disputeId, evidence]
  );

  async function loadQueue() {
    try {
      setLoading('queue');
      const all = await bffFetch<{ events: Array<{ eventType: string; entityId: string; timestamp: string }> }>('events');
      const cases = all.events
        .filter((event) => event.eventType.startsWith('dispute.'))
        .slice(-25)
        .reverse();
      setQueue(cases);
      if (!disputeId) {
        const opened = cases.find((event) => event.eventType === 'dispute.opened');
        if (opened) {
          setDisputeId(opened.entityId);
        }
      }
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load dispute queue.');
    } finally {
      setLoading(null);
    }
  }

  async function loadEvidence() {
    if (!disputeId) return;
    try {
      setLoading('evidence');
      const payload = await bffFetch<EvidencePayload>(`disputes/${disputeId}/evidence`);
      setEvidence(payload);
      setMessage(`Evidence loaded for ${disputeId}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load evidence.');
    } finally {
      setLoading(null);
    }
  }

  async function resolveDispute() {
    if (!disputeId || !targetAgentId) return;
    try {
      setLoading('resolve');
      await bffFetch(`disputes/${disputeId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          ruling,
          targetAgentId
        })
      });
      setMessage(`Dispute ${disputeId} resolved with ruling ${ruling}.`);
      await loadEvidence();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Dispute resolve failed.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <ConsoleShell
      title="Moderator Console"
      subtitle="SLA-prioritized dispute queue with evidence-first case review and sanction-linked rulings."
      rail={<EvidenceRail title="Moderator Evidence Rail" items={evidenceItems} />}
    >
      <section className="stack">
        <IdentityStrip signatureValid={evidence?.artifacts.every((item) => item.validationStatus === 'VALID')} />

        <div className="card">
          <div className="badge">Dispute Queue</div>
          <div className="button-row">
            <button type="button" onClick={loadQueue} disabled={loading !== null}>
              {loading === 'queue' ? 'Loading queue...' : 'Load queue'}
            </button>
          </div>
          {queue.length > 0 ? (
            <div className="stack-tight">
              {queue.map((event, index) => (
                <button
                  key={`${event.entityId}-${index}`}
                  type="button"
                  className="list-button"
                  onClick={() => setDisputeId(event.entityId)}
                >
                  <span>{event.eventType}</span>
                  <span className="muted-text">{event.entityId}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted-text">No disputes loaded.</p>
          )}
        </div>

        <div className="card">
          <div className="badge">Evidence First</div>
          <div className="field-grid">
            <label>
              <span>Dispute ID</span>
              <input value={disputeId} onChange={(event) => setDisputeId(event.target.value)} placeholder="dispute_..." />
            </label>
            <label>
              <span>Target agent</span>
              <input value={targetAgentId} onChange={(event) => setTargetAgentId(event.target.value)} placeholder="agent_..." />
            </label>
            <label>
              <span>Ruling</span>
              <select value={ruling} onChange={(event) => setRuling(event.target.value as 'pay_worker' | 'refund_requester' | 'split')}>
                <option value="refund_requester">refund_requester</option>
                <option value="pay_worker">pay_worker</option>
                <option value="split">split</option>
              </select>
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={loadEvidence} disabled={loading !== null || !disputeId}>
              {loading === 'evidence' ? 'Loading...' : 'Load evidence'}
            </button>
            <button type="button" onClick={resolveDispute} disabled={loading !== null || !disputeId || !targetAgentId}>
              {loading === 'resolve' ? 'Resolving...' : 'Finalize ruling'}
            </button>
          </div>

          {evidence ? (
            <div className="kv-grid">
              <div>
                <strong>Status</strong>
                <div>{evidence.dispute.status}</div>
              </div>
              <div>
                <strong>Reason</strong>
                <div>{evidence.dispute.reasonCode}</div>
              </div>
              <div>
                <strong>Appeal deadline</strong>
                <div>{new Date(evidence.dispute.appealDeadlineAt).toLocaleString()}</div>
              </div>
              <div>
                <strong>Events</strong>
                <div>{evidence.events.length}</div>
              </div>
            </div>
          ) : (
            <p className="muted-text">Load an evidence pack to review signatures, events, and policy outcomes.</p>
          )}
        </div>

        <RealtimeFeed channels={['dispute.*', 'sanction.*', 'wallet.*']} />
        {message ? <div className="card">{message}</div> : null}
      </section>
    </ConsoleShell>
  );
}
