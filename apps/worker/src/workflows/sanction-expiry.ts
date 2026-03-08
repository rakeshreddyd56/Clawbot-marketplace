/**
 * TASK-FEAT-004: Temporal scheduled workflow for sanction expiry.
 *
 * Runs on a 15-minute schedule (configured via Temporal Schedule).
 * Checks all time-limited suspensions and expires those past their duration.
 * Reactivates agents whose sanctions have all cleared.
 *
 * IMPORTANT: No Date.now() inside workflow code — use workflow.now() for deterministic time.
 * IMPORTANT: No direct I/O — all side effects go through activities.
 *
 * Schedule configuration (Temporal CLI or SDK):
 *   temporal schedule create \
 *     --schedule-id sanction-expiry \
 *     --workflow-type sanctionExpiryWorkflow \
 *     --task-queue clawbot-worker \
 *     --interval '15m'
 */

import {
  defineQuery,
  setHandler,
  proxyActivities
} from '@temporalio/workflow';

import type * as activities from '../activities/index.js';

// Proxy activities with retry policy
const {
  checkAndExpireSanctions,
  notifyStateTransition
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3
  }
});

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Query: get the last run result summary */
export const getLastRunQuery = defineQuery<SanctionExpiryResult | null>('getLastRun');

// ─── Types ────────────────────────────────────────────────────────────────────

export type SanctionExpiryResult = {
  expiredCount: number;
  reactivatedAgents: string[];
  runAt: string;
};

// ─── Workflow ─────────────────────────────────────────────────────────────────

/**
 * Sanction expiry workflow.
 *
 * This is a one-shot workflow that:
 * 1. Calls the checkAndExpireSanctions activity
 * 2. Notifies the API of any state transitions
 * 3. Returns the result for visibility
 *
 * Designed to be invoked on a Temporal Schedule (every 15 minutes).
 * Each invocation is a fresh workflow execution — no long-running state.
 *
 * Flow:
 * 1. Call checkAndExpireSanctions activity → gets { expiredCount, reactivatedAgents }
 * 2. For each reactivated agent, notify state transition
 * 3. Return summary result
 */
export async function sanctionExpiryWorkflow(): Promise<SanctionExpiryResult> {
  let lastRun: SanctionExpiryResult | null = null;

  // Query handler — return last run result
  setHandler(getLastRunQuery, () => lastRun);

  // Call the activity that checks and expires sanctions
  const result = await checkAndExpireSanctions();

  // Notify state transitions for each reactivated agent
  for (const agentId of result.reactivatedAgents) {
    await notifyStateTransition(
      agentId,
      'SUSPEND',
      'NONE',
      'sanction.expired.agent_reactivated'
    );
  }

  lastRun = {
    expiredCount: result.expiredCount,
    reactivatedAgents: result.reactivatedAgents,
    runAt: new Date().toISOString()
  };

  return lastRun;
}
