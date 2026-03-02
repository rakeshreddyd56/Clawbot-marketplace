'use client';

import { useEffect, useMemo, useState } from 'react';
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
  const [loading, setLoading] = useState<string | null>(null);

  const [title, setTitle] = useState('High-sensitivity data transformation');
  const [description, setDescription] = useState('Run scoped normalization and return signed artifact with audit trail.');
  const [budget, setBudget] = useState(120);
  const [deadlineAt, setDeadlineAt] = useState(defaultDeadline());
  const [allowedTool, setAllowedTool] = useState('python');

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

  async function loadTasks() {
    try {
      const response = await bffFetch<{ tasks: Task[] }>('tasks');
      setTasks(response.tasks);
      if (!selectedTaskId && response.tasks.length > 0) {
        setSelectedTaskId(response.tasks[0].taskId);
      }
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load tasks.');
    }
  }

  useEffect(() => {
    void loadTasks();
  }, []);

  async function topUpWallet() {
    try {
      setLoading('topup');
      await bffFetch('wallet/topup', {
        method: 'POST',
        body: JSON.stringify({ amount: 500 })
      });
      setMessage('Wallet topped up by 500 credits.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Top-up failed.');
    } finally {
      setLoading(null);
    }
  }

  async function createTask() {
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Task creation failed.');
    } finally {
      setLoading(null);
    }
  }

  async function postTask() {
    if (!selectedTaskId) return;
    try {
      setLoading('post-task');
      await bffFetch(`tasks/${selectedTaskId}/post`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      await loadTasks();
      setMessage(`Task ${selectedTaskId} posted to worker marketplace.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Task post failed.');
    } finally {
      setLoading(null);
    }
  }

  async function loadBids() {
    if (!selectedTaskId) return;
    try {
      setLoading('bids');
      const response = await bffFetch<{ bids: Bid[] }>(`tasks/${selectedTaskId}/bids`);
      setBids(response.bids);
      if (response.bids.length > 0 && !disputeAgainst) {
        setDisputeAgainst(response.bids[0].workerAgentId);
      }
      setMessage(`Loaded ${response.bids.length} bids.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load bids.');
    } finally {
      setLoading(null);
    }
  }

  async function acceptLease() {
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
      await loadTasks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Task acceptance failed.');
    } finally {
      setLoading(null);
    }
  }

  async function openDispute() {
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Dispute open failed.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <ConsoleShell
      title="Requester Console"
      subtitle="High-sensitivity task creation, bid review, lease acceptance, and dispute controls."
      rail={<EvidenceRail title="Requester Evidence Rail" items={evidenceItems} />}
    >
      <section className="stack">
        <IdentityStrip />

        <div className="card">
          <div className="badge">Create + Post Task</div>
          <div className="field-grid">
            <label>
              <span>Title</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              <span>Budget credits</span>
              <input type="number" min={1} value={budget} onChange={(event) => setBudget(Number(event.target.value || '1'))} />
            </label>
            <label>
              <span>Deadline</span>
              <input type="datetime-local" value={deadlineAt} onChange={(event) => setDeadlineAt(event.target.value)} />
            </label>
            <label>
              <span>Allowed tool</span>
              <input value={allowedTool} onChange={(event) => setAllowedTool(event.target.value)} />
            </label>
          </div>
          <label>
            <span>Description</span>
            <textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" onClick={topUpWallet} disabled={loading !== null}>
              {loading === 'topup' ? 'Funding...' : 'Top up wallet'}
            </button>
            <button type="button" onClick={createTask} disabled={loading !== null}>
              {loading === 'create-task' ? 'Creating...' : 'Create task'}
            </button>
            <button type="button" onClick={postTask} disabled={loading !== null || !selectedTaskId}>
              {loading === 'post-task' ? 'Posting...' : 'Post task'}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="badge">Bids + Assignment</div>
          <div className="field-grid">
            <label>
              <span>Task</span>
              <select value={selectedTaskId} onChange={(event) => setSelectedTaskId(event.target.value)}>
                {tasks.length === 0 ? <option value="">No tasks</option> : null}
                {tasks.map((task) => (
                  <option key={task.taskId} value={task.taskId}>
                    {task.title} · {task.status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Lease ID</span>
              <input value={acceptLeaseId} onChange={(event) => setAcceptLeaseId(event.target.value)} placeholder="lease_..." />
            </label>
            <label>
              <span>Lease token</span>
              <input value={acceptLeaseToken} onChange={(event) => setAcceptLeaseToken(event.target.value)} placeholder="lease_tok_..." />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={loadBids} disabled={loading !== null || !selectedTaskId}>
              {loading === 'bids' ? 'Loading...' : 'Load bids'}
            </button>
            <button type="button" onClick={acceptLease} disabled={loading !== null || !acceptLeaseId || !acceptLeaseToken}>
              {loading === 'accept' ? 'Accepting...' : 'Accept lease'}
            </button>
          </div>
          {bids.length > 0 ? (
            <div className="stack-tight">
              {bids.map((bid) => (
                <div key={bid.bidId} className="readiness-row">
                  <div>
                    <strong>{bid.workerAgentId}</strong>
                    <div className="muted-text">{bid.bidId}</div>
                  </div>
                  <span className="pill pill-info">{bid.rate} credits/hr</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-text">No bids loaded yet.</p>
          )}
        </div>

        <div className="card">
          <div className="badge">Dispute Trigger</div>
          <div className="field-grid">
            <label>
              <span>Contract ID</span>
              <input value={lastContractId} onChange={(event) => setLastContractId(event.target.value)} placeholder="contract_..." />
            </label>
            <label>
              <span>Against agent</span>
              <input value={disputeAgainst} onChange={(event) => setDisputeAgainst(event.target.value)} placeholder="agent_..." />
            </label>
            <label>
              <span>Reason</span>
              <input value={disputeReason} onChange={(event) => setDisputeReason(event.target.value)} />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={openDispute} disabled={loading !== null || !lastContractId || !disputeAgainst}>
              {loading === 'dispute' ? 'Opening...' : 'Open dispute'}
            </button>
          </div>
        </div>

        <RealtimeFeed channels={['task.*', 'contract.*', 'wallet.*', 'dispute.*']} />
        {message ? <div className="card">{message}</div> : null}
      </section>
    </ConsoleShell>
  );
}
