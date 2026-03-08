/**
 * TASK-HARD-004: Temporal workflow for dispute resolution orchestration.
 *
 * Manages the dispute lifecycle: DISPUTE_OPEN → (AUTO_DECIDED | APPEAL) → FINAL
 * with appeal window handled by a Temporal timer (72 hours).
 *
 * IMPORTANT: Date.now() is safe in Temporal TS SDK — the sandbox patches it
 * to return deterministic workflow time during replay.
 * IMPORTANT: No direct I/O — all side effects go through activities.
 */

import {
  defineSignal,
  defineQuery,
  setHandler,
  proxyActivities,
  condition,
  sleep
} from '@temporalio/workflow';

import type { WorkflowState } from '@claw/workflows';
import type * as activities from '../activities/index.js';

// Proxy activities with retry policy
const {
  computeDisputeResolutionTransition,
  notifyStateTransition
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    maximumAttempts: 3
  }
});

// ─── Signals ──────────────────────────────────────────────────────────────────

/** Signal: auto-decide has been issued (freeze + review) */
export const autoDecideSignal = defineSignal<[{ decision: string }]>('auto_decide');

/** Signal: a party has filed an appeal */
export const appealSignal = defineSignal<[{ appealedBy: string }]>('appeal');

/** Signal: moderator has issued a final ruling */
export const finalizeSignal = defineSignal<[{ ruling: string; moderatorId: string }]>('finalize');

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Query: get the current workflow state */
export const getStateQuery = defineQuery<WorkflowState>('getState');

/** Query: check if appeal window is still open */
export const isAppealWindowOpenQuery = defineQuery<boolean>('isAppealWindowOpen');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Appeal window: 72 hours after dispute opened */
const APPEAL_WINDOW_MS = 72 * 60 * 60 * 1000;

// ─── Workflow ─────────────────────────────────────────────────────────────────

export type DisputeResolutionArgs = {
  disputeId: string;
  contractId: string;
  openedBy: string;
  /** Override appeal window for testing (ms) */
  appealWindowMs?: number;
};

/**
 * Dispute resolution workflow.
 *
 * Orchestrates the full dispute lifecycle:
 * 1. Dispute opens in DISPUTE_OPEN state
 * 2. Auto-decide signal → transition to DISPUTE_AUTO_DECIDED
 * 3. Appeal window timer starts (72 hours)
 * 4. If appeal filed within window → transition to DISPUTE_APPEAL
 * 5. On finalize signal → transition to DISPUTE_FINAL (terminal)
 * 6. If appeal window expires with no appeal → auto-finalize
 *
 * @param args - Dispute details
 */
export async function disputeResolutionWorkflow(args: DisputeResolutionArgs): Promise<WorkflowState> {
  let state: WorkflowState = 'DISPUTE_OPEN';
  let done = false;
  let appealFiled = false;
  let appealWindowOpen = true;

  const windowMs = args.appealWindowMs ?? APPEAL_WINDOW_MS;

  // Query handlers
  setHandler(getStateQuery, () => state);
  setHandler(isAppealWindowOpenQuery, () => appealWindowOpen);

  // Signal: auto_decide
  setHandler(autoDecideSignal, async () => {
    if (done || state !== 'DISPUTE_OPEN') return;
    const prev = state;
    state = await computeDisputeResolutionTransition(state, { type: 'auto_decide' });
    await notifyStateTransition(args.disputeId, prev, state, 'dispute.auto_decided');
  });

  // Signal: appeal
  setHandler(appealSignal, async () => {
    if (done || !appealWindowOpen) return;
    if (state !== 'DISPUTE_OPEN' && state !== 'DISPUTE_AUTO_DECIDED') return;
    const prev = state;
    state = await computeDisputeResolutionTransition(state, { type: 'appeal' });
    await notifyStateTransition(args.disputeId, prev, state, 'dispute.appealed');
    appealFiled = true;
  });

  // Signal: finalize — moderator ruling
  setHandler(finalizeSignal, async ({ ruling }) => {
    if (done) return;
    const prev = state;
    state = await computeDisputeResolutionTransition(state, { type: 'finalize' });
    await notifyStateTransition(args.disputeId, prev, state, 'dispute.finalized');
    done = true;
  });

  // Wait for auto-decide signal first
  await condition(() => state === 'DISPUTE_AUTO_DECIDED' || done);

  if (!done) {
    // Start appeal window timer
    // Race: appeal window timeout vs. finalize signal
    const windowExpired = !(await condition(() => appealFiled || done, windowMs));

    if (windowExpired && !appealFiled && !done) {
      // Appeal window closed without appeal — auto-finalize
      appealWindowOpen = false;
      const prev = state;
      state = await computeDisputeResolutionTransition(state, { type: 'finalize' });
      await notifyStateTransition(args.disputeId, prev, state, 'dispute.auto_finalized');
      done = true;
    } else {
      appealWindowOpen = false;
    }
  }

  // If appeal was filed, wait for moderator to finalize
  if (!done) {
    await condition(() => done);
  }

  return state;
}
