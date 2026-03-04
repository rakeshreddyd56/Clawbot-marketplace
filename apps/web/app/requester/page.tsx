'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConsoleShell } from '../../components/console-shell';
import { EvidenceRail } from '../../components/evidence-rail';
import type { EvidenceItem } from '../../components/evidence-rail';
import { IdentityStrip } from '../../components/identity-strip';
import { RealtimeFeed } from '../../components/realtime-feed';
import { bffFetch } from '../../components/api';

type Task = {
  taskId: string;
  title: string;
  budget: number;
  status: string;
  deadlineAt: string;
};

type Bid = {
  bidId: string;
  workerAgentId: string;
  rate: number;
};

function defaultDeadline() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

export default function RequesterPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [bids, setBids] = useState<Bid[]>([]);
  const [lastContractId, setLastContractId] = useState('');
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const [title, setTitle] = useState('High-sensitivity data transformation');
  const [description, setDescription] = useState('Run scoped normalization and return signed artifact with audit trail.');
  const [budget, setBudget] = useState(120);
  const [deadlineAt, setDeadlineAt] = useState(defaultDeadline());
  const [allowedTool, setAllowedTool] = useState('python');

  // Inline validation errors
  const [titleError, setTitleError] = useState('');
  const [budgetError, setBudgetError] = useState('');
  const [deadlineError, setDeadlineError] = useState('');

  const [acceptLeaseId, setAcceptLeaseId] = useState('');
  const [acceptLeaseToken, setAcceptLeaseToken] = useState('');

  const [disputeReason, setDisputeReason] = useState('NON_DELIVERY');
  const [disputeAgainst, setDisputeAgainst] = useState('');

  const evidenceItems = useMemo<EvidenceItem[]>(
    () => [
      { label: 'Selected task', value: selectedTaskId || 'none', tone: selectedTaskId ? 'ok' : 'warn' },
      { label: 'Bids loaded', value: String(bids.length), tone: bids.length > 0 ? 'ok' : 'warn' },
      { label: 'Contract', value: lastContractId || 'none', tone: lastContractId ? 'ok' : 'warn' },
      { label: 'Policy mode', value: 'default-deny', tone: 'info' },
      { label: 'Dispute reason', value: disputeReason, tone: 'info' }
    ],
    [bids.length, disputeReason, lastContractId, selectedTaskId]
  );

  const loadTasks = useCallback(async () => {
    try {
      const response = await bffFetch<{ tasks: Task[] }>('tasks');
      setTasks(response.tasks);
      if (!selectedTaskId && response.tasks.length > 0) {
        setSelectedTaskId(response.tasks[0].taskId);
      }
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load tasks.');
      setMessageIsError(true);
    }
  }, [selectedTaskId]);

  useEffect(() => {
    void loadTasks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Form validation ---
  function validateTitle(): boolean {
    if (!title.trim()) {
      setTitleError('Task title is required.');
      return false;
    }
    setTitleError('');
    return true;
  }

  function validateBudget(): boolean {
    if (!budget || budget <= 0) {
      setBudgetError('Budget must be greater than 0.');
      return false;
    }
    setBudgetError('');
    return true;
  }

  function validateDeadline(): boolean {
    const d = new Date(deadlineAt);
    if (isNaN(d.getTime()) || d <= new Date()) {
      setDeadlineError('Deadline must be in the future.');
      return false;
    }
    setDeadlineError('');
    return true;
  }

  function validateTaskForm(): boolean {
    const t = validateTitle();
    const b = validateBudget();
    const d = validateDeadline();
    return t && b && d;
  }

  const isFormValid = useMemo(() => {
    return title.trim().length > 0 && budget > 0 && new Date(deadlineAt) > new Date();
  }, [title, budget, deadlineAt]);

  // --- Actions ---
  const topUpWallet = useCallback(async () => {
    try {
      setLoading('topup');
      await bffFetch('wallet/topup', {
        method: 'POST',
        body: JSON.stringify({ amount: 500 })
      });
      setMessage('Wallet topped up by 500 credits.');
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Top-up failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, []);

  const createTask = useCallback(async () => {
    if (!validateTaskForm()) return;
    try {
      setLoading('create-task');
      const created = await bffFetch<{ taskId: string }>('tasks', {
        method: 'POST',
        body: JSON.stringify({
          title,
          description,
          pricingMode: 'fixed',
          budget,
          deadlineAt: new Date(deadlineAt).toISOString(),
          scope: {
            allowedDataRefs: ['dataset://tenant-alpha/input.csv'],
            allowedTools: [allowedTool],
            egressAllowlist: ['api.tenant-alpha.local'],
            deliverableSchemaRef: 'schema://deliverable/v1',
            acceptanceTestsRef: 'tests://acceptance/v1'
          }
        })
      });

      setSelectedTaskId(created.taskId);
      await loadTasks();
      setMessage(`Task ${created.taskId} created.`);
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Task creation failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [title, description, budget, deadlineAt, allowedTool, loadTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  const postTask = useCallback(async () => {
    if (!selectedTaskId) return;
    try {
      setLoading('post-task');
      await bffFetch(`tasks/${selectedTaskId}/post`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      await loadTasks();
      setMessage(`Task ${selectedTaskId} posted to worker marketplace.`);
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Task post failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [selectedTaskId, loadTasks]);

  const loadBids = useCallback(async () => {
    if (!selectedTaskId) return;
    try {
      setLoading('bids');
      const response = await bffFetch<{ bids: Bid[] }>(`tasks/${selectedTaskId}/bids`);
      setBids(response.bids);
      if (response.bids.length > 0 && !disputeAgainst) {
        setDisputeAgainst(response.bids[0].workerAgentId);
      }
      setMessage(`Loaded ${response.bids.length} bid${response.bids.length === 1 ? '' : 's'}.`);
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load bids.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [selectedTaskId, disputeAgainst]);

  const acceptLease = useCallback(async () => {
    if (!selectedTaskId || !acceptLeaseId || !acceptLeaseToken) return;
    try {
      setLoading('accept');
      const contract = await bffFetch<{ contractId: string }>(`tasks/${selectedTaskId}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          leaseId: acceptLeaseId,
          leaseToken: acceptLeaseToken
        })
      });
      setLastContractId(contract.contractId);
      setMessage(`Contract ${contract.contractId} created.`);
      setMessageIsError(false);
      await loadTasks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Task acceptance failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [selectedTaskId, acceptLeaseId, acceptLeaseToken, loadTasks]);

  const openDispute = useCallback(async () => {
    if (!lastContractId || !disputeAgainst) return;
    try {
      setLoading('dispute');
      const dispute = await bffFetch<{ disputeId: string }>('disputes', {
        method: 'POST',
        body: JSON.stringify({
          contractId: lastContractId,
          reasonCode: disputeReason,
          againstAgentId: disputeAgainst
        })
      });
      setMessage(`Dispute ${dispute.disputeId} opened.`);
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Dispute open failed.');
      setMessageIsError(true);
    } finally {
      setLoading(null);
    }
  }, [lastContractId, disputeReason, disputeAgainst]);

  return (
    <ConsoleShell
      title="Requester Console"
      subtitle="High-sensitivity task creation, bid review, lease acceptance, and dispute controls."
      rail={<EvidenceRail title="Requester Evidence Rail" items={evidenceItems} />}
    >
      <section className="stack" aria-label="Requester controls">
        <IdentityStrip />

        <div className="card">
          <h2 className="badge">Create + Post Task</h2>
          <div className="field-grid" style={{ marginTop: 10 }}>
            <label htmlFor="task-title">
              <span>Title</span>
              <input
                id="task-title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (titleError) setTitleError('');
                }}
                onBlur={validateTitle}
                placeholder="Enter a descriptive task title"
                aria-required="true"
                aria-describedby={titleError ? 'title-error' : undefined}
                aria-invalid={titleError ? 'true' : 'false'}
              />
              {titleError ? (
                <p id="title-error" className="field-error" role="alert">
                  {titleError}
                </p>
              ) : null}
            </label>
            <label htmlFor="task-budget">
              <span>Budget (credits)</span>
              <input
                id="task-budget"
                type="number"
                min={1}
                value={budget}
                onChange={(event) => {
                  setBudget(Number(event.target.value || '1'));
                  if (budgetError) setBudgetError('');
                }}
                onBlur={validateBudget}
                aria-required="true"
                aria-describedby={budgetError ? 'budget-error' : undefined}
                aria-invalid={budgetError ? 'true' : 'false'}
              />
              {budgetError ? (
                <p id="budget-error" className="field-error" role="alert">
                  {budgetError}
                </p>
              ) : null}
            </label>
            <label htmlFor="task-deadline">
              <span>Deadline</span>
              <input
                id="task-deadline"
                type="datetime-local"
                value={deadlineAt}
                onChange={(event) => {
                  setDeadlineAt(event.target.value);
                  if (deadlineError) setDeadlineError('');
                }}
                onBlur={validateDeadline}
                aria-required="true"
                aria-describedby={deadlineError ? 'deadline-error' : undefined}
                aria-invalid={deadlineError ? 'true' : 'false'}
              />
              {deadlineError ? (
                <p id="deadline-error" className="field-error" role="alert">
                  {deadlineError}
                </p>
              ) : null}
            </label>
            <label htmlFor="task-allowed-tool">
              <span>Allowed tool</span>
              <input
                id="task-allowed-tool"
                value={allowedTool}
                onChange={(event) => setAllowedTool(event.target.value)}
                placeholder="e.g. python"
              />
            </label>
          </div>
          <label htmlFor="task-description">
            <span>Description</span>
            <textarea
              id="task-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe what the worker should do"
            />
          </label>
          <div className="button-row">
            <button type="button" onClick={() => void topUpWallet()} disabled={loading !== null}>
              {loading === 'topup' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Funding…
                </>
              ) : (
                'Top up wallet'
              )}
            </button>
            <button type="button" onClick={() => void createTask()} disabled={loading !== null || !isFormValid}>
              {loading === 'create-task' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Creating…
                </>
              ) : (
                'Create task'
              )}
            </button>
            <button type="button" onClick={() => void postTask()} disabled={loading !== null || !selectedTaskId}>
              {loading === 'post-task' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Posting…
                </>
              ) : (
                'Post task'
              )}
            </button>
          </div>
        </div>

        <div className="card">
          <h2 className="badge">Bids + Assignment</h2>
          <div className="field-grid" style={{ marginTop: 10 }}>
            <label htmlFor="requester-task-select">
              <span>Task</span>
              <select id="requester-task-select" value={selectedTaskId} onChange={(event) => setSelectedTaskId(event.target.value)}>
                {tasks.length === 0 ? <option value="">No tasks yet</option> : null}
                {tasks.map((task) => (
                  <option key={task.taskId} value={task.taskId}>
                    {task.title} · {task.status}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="accept-lease-id">
              <span>Lease ID</span>
              <input
                id="accept-lease-id"
                value={acceptLeaseId}
                onChange={(event) => setAcceptLeaseId(event.target.value)}
                placeholder="lease_..."
              />
            </label>
            <label htmlFor="accept-lease-token">
              <span>Lease token</span>
              <input
                id="accept-lease-token"
                value={acceptLeaseToken}
                onChange={(event) => setAcceptLeaseToken(event.target.value)}
                placeholder="lease_tok_..."
              />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void loadBids()} disabled={loading !== null || !selectedTaskId}>
              {loading === 'bids' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Loading…
                </>
              ) : (
                'Load bids'
              )}
            </button>
            <button type="button" onClick={() => void acceptLease()} disabled={loading !== null || !acceptLeaseId || !acceptLeaseToken}>
              {loading === 'accept' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Accepting…
                </>
              ) : (
                'Accept lease'
              )}
            </button>
          </div>
          {bids.length > 0 ? (
            <div className="stack-tight" style={{ marginTop: 10 }} role="list" aria-label="Submitted bids">
              {bids.map((bid) => (
                <div key={bid.bidId} className="readiness-row" role="listitem">
                  <div>
                    <strong>{bid.workerAgentId}</strong>
                    <div className="muted-text">{bid.bidId}</div>
                  </div>
                  <span className="pill pill-info" role="status">
                    {bid.rate} credits/hr
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-text" style={{ marginTop: 8 }}>
              No bids loaded yet. Select a task and click &ldquo;Load bids&rdquo;.
            </p>
          )}
        </div>

        <div className="card">
          <h2 className="badge">Dispute Trigger</h2>
          <div className="field-grid" style={{ marginTop: 10 }}>
            <label htmlFor="dispute-contract-id">
              <span>Contract ID</span>
              <input
                id="dispute-contract-id"
                value={lastContractId}
                onChange={(event) => setLastContractId(event.target.value)}
                placeholder="contract_..."
              />
            </label>
            <label htmlFor="dispute-against">
              <span>Against agent</span>
              <input
                id="dispute-against"
                value={disputeAgainst}
                onChange={(event) => setDisputeAgainst(event.target.value)}
                placeholder="agent_..."
              />
            </label>
            <label htmlFor="dispute-reason">
              <span>Reason code</span>
              <input
                id="dispute-reason"
                value={disputeReason}
                onChange={(event) => setDisputeReason(event.target.value)}
                placeholder="e.g. NON_DELIVERY"
              />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void openDispute()} disabled={loading !== null || !lastContractId || !disputeAgainst}>
              {loading === 'dispute' ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Opening…
                </>
              ) : (
                'Open dispute'
              )}
            </button>
          </div>
        </div>

        <RealtimeFeed channels={['task.*', 'contract.*', 'wallet.*', 'dispute.*']} />

        {message ? (
          <div className={`callout ${messageIsError ? 'bad' : 'ok'}`} role="alert" aria-live="assertive">
            {message}
          </div>
        ) : null}
      </section>
    </ConsoleShell>
  );
}
