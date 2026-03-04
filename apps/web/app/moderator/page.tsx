'use client';

import { useCallback, useMemo, useState } from 'react';
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
  const [messageIsError, setMessageIsError] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [disputeIdError, setDisputeIdError] = useState('');
  const [queueLoaded, setQueueLoaded] = useState(false);

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

  function validateDisputeId(): boolean {
    if (!disputeId.trim()) {
      setDisputeIdError('Dispute ID is required.');
      return false;
    }
    setDisputeIdError('');
    return true;
  }

  const loadQueue = useCallback(async () => {
    try {
      setLoading('queue');
      const all = await bffFetch<{ events: Array<{ eventType: string; entityId: string; timestamp: string }> }>('events');
      const cases = all.events
        .filter((event) => event.eventType.startsWith('dispute.'))
        .slice(-25)
        .reverse();
      setQueue(cases);
      setQueueLoaded(true);
      if (!disputeId) {
        const opened = cases.find((event) => event.eventType === 'dispute.opened');
        if (opened) {
          setDisputeId(opened.entityId);
        }
      }
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load dispute queue.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [disputeId]);

  const loadEvidence = useCallback(async () => {
    if (!validateDisputeId()) return;
    try {
      setLoading('evidence');
      const payload = await bffFetch<EvidencePayload>(`disputes/${disputeId}/evidence`);
      setEvidence(payload);
      setMessage(`Evidence loaded for ${disputeId}.`);
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load evidence.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [disputeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveDispute = useCallback(async () => {
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
      setMessage(`Dispute ${disputeId} resolved with ruling "${ruling}".`);
      setMessageIsError(false);
      await loadEvidence();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Dispute resolve failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [disputeId, targetAgentId, ruling, loadEvidence]);

  return (
    <ConsoleShell
      title="Moderator Console"
      subtitle="SLA-prioritized dispute queue with evidence-first case review and sanction-linked rulings."
      rail={<EvidenceRail title="Moderator Evidence Rail" items={evidenceItems} />}
    >
      <section className="stack" aria-label="Moderator controls">
        <IdentityStrip signatureValid={evidence?.artifacts.every((item) => item.validationStatus === 'VALID')} />

        <div className="card">
          <h2 className="badge">Dispute Queue</h2>
          <div className="button-row" style={{ marginTop: 10 }}>
            <button type="button" onClick={() => void loadQueue()} disabled={loading !== null}>
              {loading === 'queue' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Loading queue…
                </>
              ) : (
                'Load queue'
              )}
            </button>
          </div>
          {queueLoaded && queue.length === 0 ? (
            <div className="empty-state" role="status" style={{ textAlign: 'left', paddingLeft: 0 }}>
              No disputes in queue.
              <div className="muted-text" style={{ marginTop: 4, fontSize: 13 }}>
                Dispute events will appear here once they are opened.
              </div>
            </div>
          ) : queue.length > 0 ? (
            <div className="stack-tight" style={{ marginTop: 10 }} role="list" aria-label="Dispute queue">
              {queue.map((event, index) => (
                <button
                  key={`${event.entityId}-${index}`}
                  type="button"
                  className={`list-button ${disputeId === event.entityId ? 'selected' : ''}`}
                  onClick={() => {
                    setDisputeId(event.entityId);
                    if (disputeIdError) setDisputeIdError('');
                  }}
                  aria-pressed={disputeId === event.entityId}
                  aria-label={`Select dispute ${event.entityId} — ${event.eventType}`}
                  role="listitem"
                >
                  <span>{event.eventType}</span>
                  <span className="muted-text" style={{ fontSize: 12 }}>
                    {event.entityId}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2 className="badge">Evidence First</h2>
          <div className="field-grid" style={{ marginTop: 10 }}>
            <label htmlFor="mod-dispute-id">
              <span>Dispute ID</span>
              <input
                id="mod-dispute-id"
                value={disputeId}
                onChange={(event) => {
                  setDisputeId(event.target.value);
                  if (disputeIdError) setDisputeIdError('');
                }}
                onBlur={validateDisputeId}
                placeholder="dispute_..."
                aria-required="true"
                aria-describedby={disputeIdError ? 'dispute-id-error' : undefined}
                aria-invalid={disputeIdError ? 'true' : 'false'}
              />
              {disputeIdError ? (
                <p id="dispute-id-error" className="field-error" role="alert">
                  {disputeIdError}
                </p>
              ) : null}
            </label>
            <label htmlFor="mod-target-agent">
              <span>Target agent</span>
              <input
                id="mod-target-agent"
                value={targetAgentId}
                onChange={(event) => setTargetAgentId(event.target.value)}
                placeholder="agent_..."
              />
            </label>
            <label htmlFor="mod-ruling">
              <span>Ruling</span>
              <select
                id="mod-ruling"
                value={ruling}
                onChange={(event) => setRuling(event.target.value as 'pay_worker' | 'refund_requester' | 'split')}
                aria-label="Select the ruling outcome"
              >
                <option value="refund_requester">Refund requester</option>
                <option value="pay_worker">Pay worker</option>
                <option value="split">Split</option>
              </select>
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void loadEvidence()} disabled={loading !== null || !disputeId}>
              {loading === 'evidence' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Loading…
                </>
              ) : (
                'Load evidence'
              )}
            </button>
            <button
              type="button"
              onClick={() => void resolveDispute()}
              disabled={loading !== null || !disputeId || !targetAgentId}
              aria-label="Finalize the ruling for this dispute"
            >
              {loading === 'resolve' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Resolving…
                </>
              ) : (
                'Finalize ruling'
              )}
            </button>
          </div>

          {evidence ? (
            <div className="kv-grid" style={{ marginTop: 10 }}>
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
            <p className="muted-text" style={{ marginTop: 8 }}>
              Load an evidence pack to review signatures, events, and policy outcomes.
            </p>
          )}
        </div>

        <RealtimeFeed channels={['dispute.*', 'sanction.*', 'wallet.*']} />

        {message ? (
          <div className={`callout ${messageIsError ? 'bad' : 'ok'}`} role="alert" aria-live="assertive">
            {message}
          </div>
        ) : null}
      </section>
    </ConsoleShell>
  );
}
