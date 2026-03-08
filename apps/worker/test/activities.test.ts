/**
 * TASK-HARD-004: Tests for Temporal activities.
 *
 * Activities are the replay-safe boundary that wraps state machine functions.
 * These tests verify that activities correctly delegate to @claw/workflows
 * transition functions and return the expected states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeTaskLifecycleTransition,
  computeContractExecutionTransition,
  computeDisputeResolutionTransition,
  computeSanctionEscalation,
  notifyStateTransition
} from '../src/activities/index.js';

describe('Temporal Activities', () => {
  // ─── Task Lifecycle Activities ──────────────────────────────────────────────

  describe('computeTaskLifecycleTransition', () => {
    it('should transition TASK_POSTED → TASK_RESERVED on reserve', async () => {
      const result = await computeTaskLifecycleTransition('TASK_POSTED', { type: 'reserve' });
      expect(result).toBe('TASK_RESERVED');
    });

    it('should transition TASK_RESERVED → TASK_ASSIGNED on accept', async () => {
      const result = await computeTaskLifecycleTransition('TASK_RESERVED', { type: 'accept' });
      expect(result).toBe('TASK_ASSIGNED');
    });

    it('should transition TASK_RESERVED → TASK_POSTED on lease_expired', async () => {
      const result = await computeTaskLifecycleTransition('TASK_RESERVED', { type: 'lease_expired' });
      expect(result).toBe('TASK_POSTED');
    });

    it('should transition any state → TASK_CLOSED on cancel', async () => {
      const states = ['TASK_POSTED', 'TASK_RESERVED', 'TASK_ASSIGNED'] as const;
      for (const state of states) {
        const result = await computeTaskLifecycleTransition(state, { type: 'cancel' });
        expect(result).toBe('TASK_CLOSED');
      }
    });

    it('should no-op on invalid transitions', async () => {
      const result = await computeTaskLifecycleTransition('TASK_ASSIGNED', { type: 'reserve' });
      expect(result).toBe('TASK_ASSIGNED');
    });
  });

  // ─── Contract Execution Activities ──────────────────────────────────────────

  describe('computeContractExecutionTransition', () => {
    it('should transition TASK_ASSIGNED → MILESTONE_RUNNING on start_milestone', async () => {
      const result = await computeContractExecutionTransition('TASK_ASSIGNED', { type: 'start_milestone' });
      expect(result).toBe('MILESTONE_RUNNING');
    });

    it('should transition MILESTONE_RUNNING → MILESTONE_DELIVERED on deliver', async () => {
      const result = await computeContractExecutionTransition('MILESTONE_RUNNING', { type: 'deliver' });
      expect(result).toBe('MILESTONE_DELIVERED');
    });

    it('should transition MILESTONE_DELIVERED → MILESTONE_ACCEPTED on accept', async () => {
      const result = await computeContractExecutionTransition('MILESTONE_DELIVERED', { type: 'accept' });
      expect(result).toBe('MILESTONE_ACCEPTED');
    });

    it('should transition MILESTONE_RUNNING → DISPUTE_OPEN on timeout', async () => {
      const result = await computeContractExecutionTransition('MILESTONE_RUNNING', { type: 'timeout' });
      expect(result).toBe('DISPUTE_OPEN');
    });

    it('should transition any state → DISPUTE_OPEN on dispute', async () => {
      const result = await computeContractExecutionTransition('MILESTONE_DELIVERED', { type: 'dispute' });
      expect(result).toBe('DISPUTE_OPEN');
    });
  });

  // ─── Dispute Resolution Activities ──────────────────────────────────────────

  describe('computeDisputeResolutionTransition', () => {
    it('should transition DISPUTE_OPEN → DISPUTE_AUTO_DECIDED on auto_decide', async () => {
      const result = await computeDisputeResolutionTransition('DISPUTE_OPEN', { type: 'auto_decide' });
      expect(result).toBe('DISPUTE_AUTO_DECIDED');
    });

    it('should transition DISPUTE_OPEN → DISPUTE_APPEAL on appeal', async () => {
      const result = await computeDisputeResolutionTransition('DISPUTE_OPEN', { type: 'appeal' });
      expect(result).toBe('DISPUTE_APPEAL');
    });

    it('should transition DISPUTE_OPEN → DISPUTE_FINAL on finalize', async () => {
      const result = await computeDisputeResolutionTransition('DISPUTE_OPEN', { type: 'finalize' });
      expect(result).toBe('DISPUTE_FINAL');
    });

    it('should transition DISPUTE_APPEAL → DISPUTE_FINAL on finalize', async () => {
      const result = await computeDisputeResolutionTransition('DISPUTE_APPEAL', { type: 'finalize' });
      expect(result).toBe('DISPUTE_FINAL');
    });
  });

  // ─── Sanction Escalation Activities ─────────────────────────────────────────

  describe('computeSanctionEscalation', () => {
    it('should escalate NONE → SUSPEND (non-severe)', async () => {
      const result = await computeSanctionEscalation('NONE', false);
      expect(result).toBe('SUSPEND');
    });

    it('should escalate SUSPEND → BAN (non-severe)', async () => {
      const result = await computeSanctionEscalation('SUSPEND', false);
      expect(result).toBe('BAN');
    });

    it('should escalate NONE → BAN (severe)', async () => {
      const result = await computeSanctionEscalation('NONE', true);
      expect(result).toBe('BAN');
    });

    it('should stay at BAN', async () => {
      const result = await computeSanctionEscalation('BAN', false);
      expect(result).toBe('BAN');
    });
  });

  // ─── Notify State Transition Activity ───────────────────────────────────────

  describe('notifyStateTransition', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('should log structured transition event', async () => {
      await notifyStateTransition('entity-123', 'TASK_POSTED', 'TASK_RESERVED', 'task.reserved');

      expect(consoleSpy).toHaveBeenCalledOnce();
      const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logged).toMatchObject({
        level: 'info',
        msg: 'workflow_state_transition',
        entityId: 'entity-123',
        previousState: 'TASK_POSTED',
        newState: 'TASK_RESERVED',
        eventType: 'task.reserved'
      });
      expect(logged.timestamp).toBeDefined();
    });
  });
});
