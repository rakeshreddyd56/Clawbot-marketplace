/**
 * TASK-HARD-004: Temporal activities wrapping deterministic state machine functions.
 *
 * Activities are the non-deterministic boundary in Temporal. They:
 * - Call the pure state machine transition functions from @claw/workflows
 * - May perform side effects (DB writes, API calls, notifications)
 * - Are retried on failure by the Temporal worker runtime
 *
 * IMPORTANT: These activity functions are replay-safe because:
 * - State machine functions in @claw/workflows are pure (no side effects, no Date.now())
 * - Any I/O (DB writes) happens only in activities, not in workflow code
 * - Temporal records activity results and replays them on workflow replay
 */

import {
  taskLifecycleTransition,
  contractExecutionTransition,
  disputeResolutionTransition,
  sanctionEscalation,
  type WorkflowState,
  type TaskLifecycleCommand,
  type ContractExecutionCommand,
  type DisputeResolutionCommand,
  type SanctionLevel
} from '@claw/workflows';

/**
 * Activity: Compute the next task lifecycle state.
 *
 * Pure state machine transition — no side effects.
 * The workflow orchestrates the timer/signal logic;
 * this activity just computes the transition.
 */
export async function computeTaskLifecycleTransition(
  currentState: WorkflowState,
  command: TaskLifecycleCommand
): Promise<WorkflowState> {
  return taskLifecycleTransition(currentState, command);
}

/**
 * Activity: Compute the next contract execution state.
 *
 * Handles milestone lifecycle: start → deliver → accept,
 * with timeout → dispute escalation.
 */
export async function computeContractExecutionTransition(
  currentState: WorkflowState,
  command: ContractExecutionCommand
): Promise<WorkflowState> {
  return contractExecutionTransition(currentState, command);
}

/**
 * Activity: Compute the next dispute resolution state.
 *
 * Handles: auto_decide, appeal, finalize.
 */
export async function computeDisputeResolutionTransition(
  currentState: WorkflowState,
  command: DisputeResolutionCommand
): Promise<WorkflowState> {
  return disputeResolutionTransition(currentState, command);
}

/**
 * Activity: Compute the next sanction level.
 *
 * Progressive escalation: NONE → SUSPEND → BAN.
 * `severe = true` jumps directly to BAN.
 */
export async function computeSanctionEscalation(
  currentLevel: SanctionLevel,
  severe: boolean
): Promise<SanctionLevel> {
  return sanctionEscalation(currentLevel, severe);
}

/**
 * Activity: Check and expire time-limited suspensions.
 *
 * TASK-FEAT-004: Called by the sanctionExpiryWorkflow on a 15-minute schedule.
 * In production, this calls the API's SanctionService.checkAndExpireSanctions().
 * For now, it calls the API's POST /v1/sanctions/expire endpoint.
 *
 * Returns { expiredCount, reactivatedAgents } for workflow visibility.
 */
export async function checkAndExpireSanctions(): Promise<{
  expiredCount: number;
  reactivatedAgents: string[];
}> {
  // In production: HTTP POST to API /v1/sanctions/expire with admin credentials
  // The API endpoint calls SanctionService.checkAndExpireSanctions() which:
  // 1. Iterates all sanctions and expires time-limited ones past duration
  // 2. Reactivates agents with no remaining active sanctions
  // 3. Publishes audit events for each expiry and reactivation
  const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
  try {
    const response = await fetch(`${apiBaseUrl}/v1/sanctions/expire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-id': 'system:sanction-expiry-worker',
        'x-role': 'admin'
      }
    });

    if (!response.ok) {
      throw new Error(`Sanction expiry API call failed: ${response.status}`);
    }

    return await response.json() as { expiredCount: number; reactivatedAgents: string[] };
  } catch (error) {
    // Log and rethrow — Temporal will retry based on activity retry policy
    console.error(JSON.stringify({
      level: 'error',
      msg: 'sanction_expiry_activity_failed',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }));
    throw error;
  }
}

/**
 * Activity: Apply a default ruling on a dispute whose response deadline has expired.
 *
 * TASK-ENFORCE-004: Called by disputeDeadlineWorkflow when the 72h response
 * window expires with no response from the target party.
 * In production, this calls the API's dispute ruling endpoint.
 *
 * Returns void — the ruling is applied server-side.
 */
export async function applyDisputeDefaultRuling(args: {
  disputeId: string;
  contractId: string;
  openedBy: string;
  againstAgentId: string;
  reason: string;
}): Promise<void> {
  const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
  try {
    const response = await fetch(`${apiBaseUrl}/v1/disputes/${args.disputeId}/default-ruling`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-id': 'system:dispute-deadline-worker',
        'x-role': 'admin'
      },
      body: JSON.stringify({
        ruling: 'default_in_favor_of_opener',
        reason: args.reason,
        openedBy: args.openedBy,
        againstAgentId: args.againstAgentId,
        contractId: args.contractId
      })
    });

    if (!response.ok) {
      throw new Error(`Default ruling API call failed: ${response.status}`);
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'apply_dispute_default_ruling_failed',
      disputeId: args.disputeId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }));
    throw error;
  }
}

/**
 * Activity: Notify the API of a state transition.
 *
 * In production, this would call back to the API service to persist
 * the state change, update audit logs, etc. For now, it logs.
 *
 * This is the side-effect boundary — all I/O happens here.
 */
export async function notifyStateTransition(
  entityId: string,
  previousState: WorkflowState | SanctionLevel,
  newState: WorkflowState | SanctionLevel,
  eventType: string
): Promise<void> {
  // In production: HTTP callback to API, or Kafka event publish
  // For now: structured log output
  console.log(JSON.stringify({
    level: 'info',
    msg: 'workflow_state_transition',
    entityId,
    previousState,
    newState,
    eventType,
    timestamp: new Date().toISOString()
  }));
}
