/**
 * TASK-ENFORCE-004: Temporal workflow for dispute response deadline (72h auto-ruling).
 *
 * Enforces Rule A-1: target party must respond within 72 hours of dispute opening.
 * If no response (appeal or moderator resolve) is received by the deadline,
 * the workflow signals the API to apply a default ruling in favor of the opener.
 *
 * Flow:
 * 1. Workflow starts when a dispute is opened (scheduled by API)
 * 2. Timer set for 72 hours (configurable via deadlineMs arg)
 * 3. If response signal received before timer → workflow completes (no action)
 * 4. If timer fires without response → calls sweepDispute activity to apply default ruling
 *
 * IMPORTANT: Date.now() is deterministic in Temporal TS SDK (sandbox-patched).
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

import type * as activities from '../activities/index.js';

// Proxy activities with retry policy
const {
  applyDisputeDefaultRuling,
  notifyStateTransition
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2
  }
});

// ─── Signals ──────────────────────────────────────────────────────────────────

/**
 * Signal: target party has responded to the dispute (appeal filed or moderator resolved).
 * When received, the deadline timer is cancelled and no auto-ruling occurs.
 */
export const disputeResponseSignal = defineSignal<[{
  respondedBy: string;
  responseType: 'appeal' | 'resolve';
}]>('dispute_response');

/**
 * Signal: dispute was resolved by a moderator before deadline.
 * Cancels the deadline timer.
 */
export const disputeResolvedSignal = defineSignal<[{
  ruling: string;
  moderatorId: string;
}]>('dispute_resolved');

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Query: check if the response deadline has passed */
export const isDeadlineExpiredQuery = defineQuery<boolean>('isDeadlineExpired');

/** Query: check if the target party has responded */
export const hasRespondedQuery = defineQuery<boolean>('hasResponded');

/** Query: get the current workflow outcome */
export const getOutcomeQuery = defineQuery<'pending' | 'responded' | 'auto_ruled'>('getOutcome');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default response deadline: 72 hours */
const RESPONSE_DEADLINE_MS = 72 * 60 * 60 * 1000;

// ─── Workflow ─────────────────────────────────────────────────────────────────

export type DisputeDeadlineArgs = {
  disputeId: string;
  contractId: string;
  openedBy: string;
  againstAgentId: string;
  /** Override deadline for testing (ms). Defaults to 72 hours. */
  deadlineMs?: number;
};

/**
 * Dispute response deadline workflow.
 *
 * Starts a countdown timer for the target party to respond to a dispute.
 * If no response is received within the deadline, applies a default ruling
 * in favor of the dispute opener via the sweepDispute activity.
 *
 * @param args - Dispute details and optional deadline override
 * @returns 'responded' if target responded, 'auto_ruled' if deadline expired
 */
export async function disputeDeadlineWorkflow(args: DisputeDeadlineArgs): Promise<'responded' | 'auto_ruled'> {
  let responded = false;
  let resolved = false;
  let deadlineExpired = false;
  let outcome: 'pending' | 'responded' | 'auto_ruled' = 'pending';

  const deadlineMs = args.deadlineMs ?? RESPONSE_DEADLINE_MS;

  // Query handlers
  setHandler(isDeadlineExpiredQuery, () => deadlineExpired);
  setHandler(hasRespondedQuery, () => responded);
  setHandler(getOutcomeQuery, () => outcome);

  // Signal: target party responded (appeal or moderator resolved within window)
  setHandler(disputeResponseSignal, ({ respondedBy, responseType }) => {
    if (deadlineExpired) return; // Too late
    responded = true;
    outcome = 'responded';
    void notifyStateTransition(
      args.disputeId,
      'DISPUTE_AUTO_DECIDED',
      responseType === 'appeal' ? 'DISPUTE_APPEAL' : 'DISPUTE_FINAL',
      'dispute.response_received'
    );
  });

  // Signal: dispute resolved externally
  setHandler(disputeResolvedSignal, () => {
    if (deadlineExpired) return;
    resolved = true;
    responded = true;
    outcome = 'responded';
  });

  // Race: wait for response vs. deadline expiry
  const gotResponse = await condition(() => responded || resolved, deadlineMs);

  if (!gotResponse && !responded && !resolved) {
    // Deadline expired with no response — apply default ruling
    deadlineExpired = true;
    outcome = 'auto_ruled';

    await applyDisputeDefaultRuling({
      disputeId: args.disputeId,
      contractId: args.contractId,
      openedBy: args.openedBy,
      againstAgentId: args.againstAgentId,
      reason: 'RESPONSE_TIMEOUT'
    });
  }

  return outcome as 'responded' | 'auto_ruled';
}
