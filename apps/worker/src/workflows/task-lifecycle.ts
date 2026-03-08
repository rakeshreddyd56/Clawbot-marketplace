/**
 * TASK-HARD-004: Temporal workflow for task lifecycle orchestration.
 *
 * Manages the task state machine: TASK_POSTED → TASK_RESERVED → TASK_ASSIGNED → TASK_CLOSED
 * with lease expiry handled by Temporal timers (not lazy expiry).
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
  sleep,
  proxyActivities,
  CancellationScope,
  condition
} from '@temporalio/workflow';

import type { WorkflowState } from '@claw/workflows';
import type * as activities from '../activities/index.js';

// Proxy activities with retry policy
const {
  computeTaskLifecycleTransition,
  notifyStateTransition
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    maximumAttempts: 3
  }
});

// ─── Signals ──────────────────────────────────────────────────────────────────

/** Signal: a worker has reserved this task */
export const reserveSignal = defineSignal<[{ workerAgentId: string; leaseId: string }]>('reserve');

/** Signal: a worker has accepted this task (lease validated) */
export const acceptSignal = defineSignal<[{ workerAgentId: string; contractId: string }]>('accept');

/** Signal: the task has been cancelled by the requester */
export const cancelSignal = defineSignal<[{ reasonCode: string }]>('cancel');

/** Signal: heartbeat received from the worker (extends lease) */
export const heartbeatSignal = defineSignal<[{ leaseId: string }]>('heartbeat');

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Query: get the current workflow state */
export const getStateQuery = defineQuery<WorkflowState>('getState');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Lease duration in milliseconds (2 minutes) */
const LEASE_DURATION_MS = 2 * 60 * 1000;

/** Heartbeat extends lease by this amount (2 minutes from heartbeat time) */
const HEARTBEAT_EXTENSION_MS = 2 * 60 * 1000;

// ─── Workflow ─────────────────────────────────────────────────────────────────

/**
 * Task lifecycle workflow.
 *
 * Orchestrates the full task lifecycle from POSTED to ASSIGNED or CLOSED.
 * Lease expiry is handled by a Temporal timer — no lazy expiry needed.
 *
 * Flow:
 * 1. Task starts in TASK_POSTED state
 * 2. On reserve signal → transition to TASK_RESERVED, start lease timer
 * 3. If lease expires (no accept within 2 min) → back to TASK_POSTED
 * 4. On heartbeat → extend lease timer
 * 5. On accept signal → transition to TASK_ASSIGNED, workflow completes
 * 6. On cancel signal → transition to TASK_CLOSED, workflow completes
 *
 * @param taskId - The task entity ID (used for correlation)
 */
export async function taskLifecycleWorkflow(taskId: string): Promise<WorkflowState> {
  let state: WorkflowState = 'TASK_POSTED';
  let leaseActive = false;
  let lastHeartbeatMs = 0;
  let done = false;

  // Query handler — return current state
  setHandler(getStateQuery, () => state);

  // Signal: cancel — can happen in any non-terminal state
  setHandler(cancelSignal, async () => {
    if (done) return;
    const prev = state;
    state = await computeTaskLifecycleTransition(state, { type: 'cancel' });
    await notifyStateTransition(taskId, prev, state, 'task.canceled');
    leaseActive = false;
    done = true;
  });

  // Signal: reserve — start lease timer
  setHandler(reserveSignal, async () => {
    if (done || state !== 'TASK_POSTED') return;
    const prev = state;
    state = await computeTaskLifecycleTransition(state, { type: 'reserve' });
    await notifyStateTransition(taskId, prev, state, 'task.reserved');
    leaseActive = true;
    // Date.now() is replay-safe — Temporal TS SDK sandbox intercepts it
    lastHeartbeatMs = Date.now();
  });

  // Signal: accept — finalize assignment
  setHandler(acceptSignal, async () => {
    if (done || state !== 'TASK_RESERVED') return;
    const prev = state;
    state = await computeTaskLifecycleTransition(state, { type: 'accept' });
    await notifyStateTransition(taskId, prev, state, 'task.accepted');
    leaseActive = false;
    done = true;
  });

  // Signal: heartbeat — extend lease
  setHandler(heartbeatSignal, () => {
    if (leaseActive) {
      lastHeartbeatMs = Date.now();
    }
  });

  // Main loop: handle lease expiry via Temporal timer
  while (!done) {
    if (leaseActive) {
      // Wait for lease duration or until state changes
      const leaseExpired = !(await condition(() => !leaseActive || done, LEASE_DURATION_MS));

      if (leaseExpired && leaseActive && !done) {
        // Check if a recent heartbeat extended the lease
        const elapsed = Date.now() - lastHeartbeatMs;
        if (elapsed >= LEASE_DURATION_MS) {
          // Lease truly expired — roll back to POSTED
          const prev = state;
          state = await computeTaskLifecycleTransition(state, { type: 'lease_expired' });
          await notifyStateTransition(taskId, prev, state, 'lease.expired');
          leaseActive = false;
        }
        // Otherwise heartbeat extended it — continue the loop
      }
    } else if (!done) {
      // No active lease — wait for a signal
      await condition(() => leaseActive || done);
    }
  }

  return state;
}
