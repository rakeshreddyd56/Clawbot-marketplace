/**
 * TASK-HARD-004: Temporal workflow for contract execution orchestration.
 *
 * Manages the milestone lifecycle: start → deliver → accept,
 * with timeout escalation to disputes.
 *
 * DETERMINISM NOTE: In the Temporal TypeScript SDK, Date.now() is automatically
 * intercepted by the workflow sandbox and returns deterministic workflow time
 * during replay. This is the standard approach — there is no separate workflow.now()
 * API in the TS SDK. All Date/timer usage below is replay-safe.
 *
 * IMPORTANT: No direct I/O — all side effects go through activities.
 */

import {
  defineSignal,
  defineQuery,
  setHandler,
  proxyActivities,
  condition
} from '@temporalio/workflow';

import type { WorkflowState } from '@claw/workflows';
import type * as activities from '../activities/index.js';

// Proxy activities with retry policy
const {
  computeContractExecutionTransition,
  notifyStateTransition
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    maximumAttempts: 3
  }
});

// ─── Signals ──────────────────────────────────────────────────────────────────

/** Signal: milestone work has started */
export const startMilestoneSignal = defineSignal<[{ milestoneId: string }]>('start_milestone');

/** Signal: worker has delivered the milestone */
export const deliverSignal = defineSignal<[{ milestoneId: string; artifactId: string }]>('deliver');

/** Signal: requester has accepted the milestone */
export const acceptSignal = defineSignal<[{ milestoneId: string }]>('accept');

/** Signal: a party has opened a dispute */
export const disputeSignal = defineSignal<[{ disputeId: string; reasonCode: string }]>('dispute');

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Query: get the current workflow state */
export const getStateQuery = defineQuery<WorkflowState>('getState');

/** Query: get the current milestone being processed */
export const getCurrentMilestoneQuery = defineQuery<string | null>('getCurrentMilestone');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Milestone timeout: if no delivery within this window, escalate to dispute */
const MILESTONE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours (configurable per contract)

// ─── Workflow ─────────────────────────────────────────────────────────────────

export type ContractExecutionArgs = {
  contractId: string;
  milestoneIds: string[];
  deadlineMs?: number;
};

/**
 * Contract execution workflow.
 *
 * Orchestrates the full contract lifecycle from TASK_ASSIGNED through
 * all milestones to completion, with timeout-based dispute escalation.
 *
 * Flow per milestone:
 * 1. Start milestone → MILESTONE_RUNNING
 * 2. Wait for delivery (with timeout)
 * 3. If timeout → DISPUTE_OPEN (escalate)
 * 4. On delivery → MILESTONE_DELIVERED
 * 5. Wait for acceptance
 * 6. On acceptance → MILESTONE_ACCEPTED → next milestone or done
 *
 * @param args - Contract details and milestone IDs
 */
export async function contractExecutionWorkflow(args: ContractExecutionArgs): Promise<WorkflowState> {
  let state: WorkflowState = 'TASK_ASSIGNED';
  let currentMilestoneId: string | null = null;
  let done = false;
  let milestoneDelivered = false;
  let milestoneAccepted = false;
  let disputed = false;

  const timeoutMs = args.deadlineMs ?? MILESTONE_TIMEOUT_MS;

  // Query handlers
  setHandler(getStateQuery, () => state);
  setHandler(getCurrentMilestoneQuery, () => currentMilestoneId);

  // Signal: start milestone
  setHandler(startMilestoneSignal, async ({ milestoneId }) => {
    if (done || state !== 'TASK_ASSIGNED') return;
    currentMilestoneId = milestoneId;
    const prev = state;
    state = await computeContractExecutionTransition(state, { type: 'start_milestone' });
    await notifyStateTransition(args.contractId, prev, state, 'milestone.started');
  });

  // Signal: deliver
  setHandler(deliverSignal, async ({ milestoneId }) => {
    if (done || state !== 'MILESTONE_RUNNING') return;
    if (milestoneId !== currentMilestoneId) return;
    const prev = state;
    state = await computeContractExecutionTransition(state, { type: 'deliver' });
    await notifyStateTransition(args.contractId, prev, state, 'milestone.delivered');
    milestoneDelivered = true;
  });

  // Signal: accept
  setHandler(acceptSignal, async ({ milestoneId }) => {
    if (done || state !== 'MILESTONE_DELIVERED') return;
    if (milestoneId !== currentMilestoneId) return;
    const prev = state;
    state = await computeContractExecutionTransition(state, { type: 'accept' });
    await notifyStateTransition(args.contractId, prev, state, 'milestone.accepted');
    milestoneAccepted = true;
  });

  // Signal: dispute
  setHandler(disputeSignal, async () => {
    if (done) return;
    const prev = state;
    state = await computeContractExecutionTransition(state, { type: 'dispute' });
    await notifyStateTransition(args.contractId, prev, state, 'dispute.opened');
    disputed = true;
    done = true;
  });

  // Process milestones sequentially
  for (const milestoneId of args.milestoneIds) {
    if (done) break;

    // Wait for milestone start signal
    await condition(() => currentMilestoneId === milestoneId || done);
    if (done) break;

    // Wait for delivery with timeout
    milestoneDelivered = false;
    const delivered = await condition(() => milestoneDelivered || disputed || done, timeoutMs);

    if (!delivered && !milestoneDelivered && !disputed && !done) {
      // Timeout: escalate to dispute
      const prev = state;
      state = await computeContractExecutionTransition(state, { type: 'timeout' });
      await notifyStateTransition(args.contractId, prev, state, 'milestone.timeout');
      done = true;
      break;
    }

    if (done) break;

    // Wait for acceptance
    milestoneAccepted = false;
    await condition(() => milestoneAccepted || disputed || done);

    if (done) break;

    // Reset state for next milestone.
    // Cast needed: TS control flow can't track async signal handler mutations.
    if ((state as WorkflowState) === 'MILESTONE_ACCEPTED') {
      // If more milestones, go back to TASK_ASSIGNED
      const remaining = args.milestoneIds.indexOf(milestoneId);
      if (remaining < args.milestoneIds.length - 1) {
        state = 'TASK_ASSIGNED';
      }
    }
  }

  return state;
}
