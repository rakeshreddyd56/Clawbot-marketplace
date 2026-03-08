/**
 * TASK-HARD-004: Temporal workflow integration tests.
 *
 * Uses @temporalio/testing TestWorkflowEnvironment to run workflows
 * with a real (embedded) Temporal test server. This validates:
 * - Workflow signal/query handling
 * - Timer-based lease expiry
 * - State machine transitions via activities
 * - Replay safety (no non-deterministic operations in workflow code)
 *
 * NOTE: These tests require the @temporalio/testing native bindings.
 * If the Temporal test server binary is not available, tests are skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as path from 'node:path';
import * as url from 'node:url';

// Resolve workflow file paths for the worker
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const workflowsPath = path.resolve(__dirname, '../src/workflows');

// ─── Test Environment Setup ──────────────────────────────────────────────────

let testEnv: TestWorkflowEnvironment | undefined;

// Try to start the test environment; skip all tests if Temporal binaries unavailable
let envAvailable = false;

beforeAll(async () => {
  try {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
    envAvailable = true;
  } catch (err) {
    console.warn('⚠️  Temporal test server not available, skipping workflow integration tests:', (err as Error).message);
    envAvailable = false;
  }
}, 60_000); // Allow 60s for test server download

afterAll(async () => {
  if (testEnv) {
    await testEnv.teardown();
  }
});

// Helper: run a workflow with activities in the test environment.
// Gracefully skips the test if Temporal test server is not available.
async function runWithWorker<T>(
  ctx: { skip: { call: (instance: unknown, reason: string) => never } },
  fn: (env: TestWorkflowEnvironment, taskQueue: string) => Promise<T>
): Promise<T> {
  if (!envAvailable || !testEnv) {
    ctx.skip.call(ctx, 'Temporal test server not available');
    return undefined as never;
  }

  const taskQueue = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const activities = await import('../src/activities/index.js');

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath,
    activities
  });

  return await worker.runUntil(fn(testEnv, taskQueue));
}

// ─── Task Lifecycle Workflow Tests ────────────────────────────────────────────

describe('taskLifecycleWorkflow', () => {
  it('should start in TASK_POSTED state', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('taskLifecycleWorkflow', {
        taskQueue,
        workflowId: 'test-task-1',
        args: ['task-001']
      });

      // Query the state
      const state = await handle.query('getState');
      expect(state).toBe('TASK_POSTED');

      // Cancel to clean up
      await handle.signal('cancel', { reasonCode: 'test-cleanup' });
      const result = await handle.result();
      expect(result).toBe('TASK_CLOSED');
    });
  }, 30_000);

  it('should transition through reserve → accept lifecycle', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('taskLifecycleWorkflow', {
        taskQueue,
        workflowId: 'test-task-2',
        args: ['task-002']
      });

      // Reserve
      await handle.signal('reserve', { workerAgentId: 'worker-1', leaseId: 'lease-1' });
      // Small delay for signal processing
      await new Promise(resolve => setTimeout(resolve, 200));
      const stateAfterReserve = await handle.query('getState');
      expect(stateAfterReserve).toBe('TASK_RESERVED');

      // Accept
      await handle.signal('accept', { workerAgentId: 'worker-1', contractId: 'contract-1' });
      const result = await handle.result();
      expect(result).toBe('TASK_ASSIGNED');
    });
  }, 30_000);

  it('should handle lease expiry via Temporal timer', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('taskLifecycleWorkflow', {
        taskQueue,
        workflowId: 'test-task-3',
        args: ['task-003']
      });

      // Reserve (starts 2-minute lease timer)
      await handle.signal('reserve', { workerAgentId: 'worker-1', leaseId: 'lease-1' });
      await new Promise(resolve => setTimeout(resolve, 200));

      const stateAfterReserve = await handle.query('getState');
      expect(stateAfterReserve).toBe('TASK_RESERVED');

      // Skip time past lease duration (2 minutes + buffer)
      await env.sleep('3 minutes');

      // After lease expires, should be back to TASK_POSTED
      const stateAfterExpiry = await handle.query('getState');
      expect(stateAfterExpiry).toBe('TASK_POSTED');

      // Cancel to clean up
      await handle.signal('cancel', { reasonCode: 'test-cleanup' });
      const result = await handle.result();
      expect(result).toBe('TASK_CLOSED');
    });
  }, 30_000);

  it('should handle cancel in any state', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('taskLifecycleWorkflow', {
        taskQueue,
        workflowId: 'test-task-4',
        args: ['task-004']
      });

      // Cancel from POSTED state
      await handle.signal('cancel', { reasonCode: 'requester-cancelled' });
      const result = await handle.result();
      expect(result).toBe('TASK_CLOSED');
    });
  }, 30_000);

  it('should extend lease on heartbeat', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('taskLifecycleWorkflow', {
        taskQueue,
        workflowId: 'test-task-5',
        args: ['task-005']
      });

      // Reserve
      await handle.signal('reserve', { workerAgentId: 'worker-1', leaseId: 'lease-1' });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Skip 1 minute (within lease window)
      await env.sleep('1 minute');

      // Send heartbeat
      await handle.signal('heartbeat', { leaseId: 'lease-1' });

      // Skip another 1.5 minutes — without heartbeat, total would be 2.5min (expired)
      // But heartbeat reset it, so should still be RESERVED
      await env.sleep('1.5 minutes');
      const state = await handle.query('getState');
      expect(state).toBe('TASK_RESERVED');

      // Accept to clean up
      await handle.signal('accept', { workerAgentId: 'worker-1', contractId: 'c-1' });
      const result = await handle.result();
      expect(result).toBe('TASK_ASSIGNED');
    });
  }, 30_000);
});

// ─── Contract Execution Workflow Tests ────────────────────────────────────────

describe('contractExecutionWorkflow', () => {
  it('should complete a full milestone lifecycle', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('contractExecutionWorkflow', {
        taskQueue,
        workflowId: 'test-contract-1',
        args: [{
          contractId: 'contract-001',
          milestoneIds: ['ms-1'],
          deadlineMs: 60_000 // 1 minute for testing
        }]
      });

      // Start milestone
      await handle.signal('start_milestone', { milestoneId: 'ms-1' });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await handle.query('getState')).toBe('MILESTONE_RUNNING');

      // Deliver
      await handle.signal('deliver', { milestoneId: 'ms-1', artifactId: 'art-1' });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await handle.query('getState')).toBe('MILESTONE_DELIVERED');

      // Accept
      await handle.signal('accept', { milestoneId: 'ms-1' });
      const result = await handle.result();
      expect(result).toBe('MILESTONE_ACCEPTED');
    });
  }, 30_000);

  it('should escalate to dispute on timeout', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('contractExecutionWorkflow', {
        taskQueue,
        workflowId: 'test-contract-2',
        args: [{
          contractId: 'contract-002',
          milestoneIds: ['ms-1'],
          deadlineMs: 5_000 // 5 seconds
        }]
      });

      // Start milestone
      await handle.signal('start_milestone', { milestoneId: 'ms-1' });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Skip past timeout
      await env.sleep('10 seconds');

      const result = await handle.result();
      expect(result).toBe('DISPUTE_OPEN');
    });
  }, 30_000);

  it('should handle dispute signal', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('contractExecutionWorkflow', {
        taskQueue,
        workflowId: 'test-contract-3',
        args: [{
          contractId: 'contract-003',
          milestoneIds: ['ms-1'],
          deadlineMs: 60_000
        }]
      });

      // Start milestone
      await handle.signal('start_milestone', { milestoneId: 'ms-1' });
      await new Promise(resolve => setTimeout(resolve, 200));

      // File dispute
      await handle.signal('dispute', { disputeId: 'd-1', reasonCode: 'quality' });
      const result = await handle.result();
      expect(result).toBe('DISPUTE_OPEN');
    });
  }, 30_000);

  it('should handle multi-milestone contracts', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('contractExecutionWorkflow', {
        taskQueue,
        workflowId: 'test-contract-4',
        args: [{
          contractId: 'contract-004',
          milestoneIds: ['ms-1', 'ms-2'],
          deadlineMs: 60_000
        }]
      });

      // Milestone 1: start → deliver → accept
      await handle.signal('start_milestone', { milestoneId: 'ms-1' });
      await new Promise(resolve => setTimeout(resolve, 200));
      await handle.signal('deliver', { milestoneId: 'ms-1', artifactId: 'art-1' });
      await new Promise(resolve => setTimeout(resolve, 200));
      await handle.signal('accept', { milestoneId: 'ms-1' });
      await new Promise(resolve => setTimeout(resolve, 200));

      // After first milestone accepted, state should be back to TASK_ASSIGNED
      expect(await handle.query('getState')).toBe('TASK_ASSIGNED');

      // Milestone 2: start → deliver → accept
      await handle.signal('start_milestone', { milestoneId: 'ms-2' });
      await new Promise(resolve => setTimeout(resolve, 200));
      await handle.signal('deliver', { milestoneId: 'ms-2', artifactId: 'art-2' });
      await new Promise(resolve => setTimeout(resolve, 200));
      await handle.signal('accept', { milestoneId: 'ms-2' });

      const result = await handle.result();
      expect(result).toBe('MILESTONE_ACCEPTED');
    });
  }, 30_000);
});

// ─── Dispute Resolution Workflow Tests ────────────────────────────────────────

describe('disputeResolutionWorkflow', () => {
  it('should handle auto-decide → appeal → finalize', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('disputeResolutionWorkflow', {
        taskQueue,
        workflowId: 'test-dispute-1',
        args: [{
          disputeId: 'dispute-001',
          contractId: 'contract-001',
          openedBy: 'agent-1',
          appealWindowMs: 10_000 // 10 seconds for testing
        }]
      });

      // Auto-decide
      await handle.signal('auto_decide', { decision: 'freeze_and_review' });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await handle.query('getState')).toBe('DISPUTE_AUTO_DECIDED');
      expect(await handle.query('isAppealWindowOpen')).toBe(true);

      // Appeal
      await handle.signal('appeal', { appealedBy: 'agent-2' });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await handle.query('getState')).toBe('DISPUTE_APPEAL');

      // Finalize
      await handle.signal('finalize', { ruling: 'pay_worker', moderatorId: 'mod-1' });
      const result = await handle.result();
      expect(result).toBe('DISPUTE_FINAL');
    });
  }, 30_000);

  it('should auto-finalize when appeal window expires', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('disputeResolutionWorkflow', {
        taskQueue,
        workflowId: 'test-dispute-2',
        args: [{
          disputeId: 'dispute-002',
          contractId: 'contract-002',
          openedBy: 'agent-1',
          appealWindowMs: 5_000 // 5 seconds for testing
        }]
      });

      // Auto-decide
      await handle.signal('auto_decide', { decision: 'freeze_and_review' });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Skip past appeal window
      await env.sleep('10 seconds');

      // Should auto-finalize
      const result = await handle.result();
      expect(result).toBe('DISPUTE_FINAL');
    });
  }, 30_000);

  it('should support direct finalize without appeal', async (ctx) => {
    await runWithWorker(ctx, async (env, taskQueue) => {
      const handle = await env.client.workflow.start('disputeResolutionWorkflow', {
        taskQueue,
        workflowId: 'test-dispute-3',
        args: [{
          disputeId: 'dispute-003',
          contractId: 'contract-003',
          openedBy: 'agent-1',
          appealWindowMs: 60_000
        }]
      });

      // Auto-decide
      await handle.signal('auto_decide', { decision: 'freeze_and_review' });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Immediately finalize (moderator acts fast)
      await handle.signal('finalize', { ruling: 'refund_requester', moderatorId: 'mod-1' });
      const result = await handle.result();
      expect(result).toBe('DISPUTE_FINAL');
    });
  }, 30_000);
});
