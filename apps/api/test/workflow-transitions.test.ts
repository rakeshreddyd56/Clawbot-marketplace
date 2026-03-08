/**
 * BUG-MIN-001: Workflow state machine transition fixes.
 *
 * Two bugs fixed:
 * 1. cancel command returned TASK_POSTED instead of TASK_CLOSED
 * 2. auto_decide command returned DISPUTE_OPEN instead of DISPUTE_AUTO_DECIDED
 *
 * These transitions must match domain behavior for Temporal replay safety.
 */

import { describe, expect, it } from 'vitest';
import {
  taskLifecycleTransition,
  contractExecutionTransition,
  disputeResolutionTransition,
  type WorkflowState
} from '@claw/workflows';

describe('BUG-MIN-001: workflow state machine transitions', () => {
  // ── Task lifecycle transitions ───────────────────────────────────────
  describe('taskLifecycleTransition', () => {
    it('cancel from TASK_POSTED → TASK_CLOSED (not TASK_POSTED)', () => {
      const result = taskLifecycleTransition('TASK_POSTED', { type: 'cancel' });
      expect(result).toBe('TASK_CLOSED');
    });

    it('cancel from TASK_RESERVED → TASK_CLOSED (not TASK_POSTED)', () => {
      const result = taskLifecycleTransition('TASK_RESERVED', { type: 'cancel' });
      expect(result).toBe('TASK_CLOSED');
    });

    it('cancel from TASK_ASSIGNED → TASK_CLOSED', () => {
      const result = taskLifecycleTransition('TASK_ASSIGNED', { type: 'cancel' });
      expect(result).toBe('TASK_CLOSED');
    });

    it('reserve from TASK_POSTED → TASK_RESERVED (unchanged)', () => {
      expect(taskLifecycleTransition('TASK_POSTED', { type: 'reserve' })).toBe('TASK_RESERVED');
    });

    it('accept from TASK_RESERVED → TASK_ASSIGNED (unchanged)', () => {
      expect(taskLifecycleTransition('TASK_RESERVED', { type: 'accept' })).toBe('TASK_ASSIGNED');
    });

    it('lease_expired from TASK_RESERVED → TASK_POSTED (unchanged)', () => {
      expect(taskLifecycleTransition('TASK_RESERVED', { type: 'lease_expired' })).toBe('TASK_POSTED');
    });
  });

  // ── Dispute resolution transitions ──────────────────────────────────
  describe('disputeResolutionTransition', () => {
    it('auto_decide from DISPUTE_OPEN → DISPUTE_AUTO_DECIDED (not DISPUTE_OPEN)', () => {
      const result = disputeResolutionTransition('DISPUTE_OPEN', { type: 'auto_decide' });
      expect(result).toBe('DISPUTE_AUTO_DECIDED');
    });

    it('appeal from DISPUTE_OPEN → DISPUTE_APPEAL (unchanged)', () => {
      expect(disputeResolutionTransition('DISPUTE_OPEN', { type: 'appeal' })).toBe('DISPUTE_APPEAL');
    });

    it('finalize from DISPUTE_OPEN → DISPUTE_FINAL (unchanged)', () => {
      expect(disputeResolutionTransition('DISPUTE_OPEN', { type: 'finalize' })).toBe('DISPUTE_FINAL');
    });

    it('finalize from DISPUTE_APPEAL → DISPUTE_FINAL (unchanged)', () => {
      expect(disputeResolutionTransition('DISPUTE_APPEAL', { type: 'finalize' })).toBe('DISPUTE_FINAL');
    });
  });

  // ── Contract execution transitions (unchanged, regression check) ────
  describe('contractExecutionTransition', () => {
    it('start_milestone from TASK_ASSIGNED → MILESTONE_RUNNING', () => {
      expect(contractExecutionTransition('TASK_ASSIGNED', { type: 'start_milestone' })).toBe('MILESTONE_RUNNING');
    });

    it('deliver from MILESTONE_RUNNING → MILESTONE_DELIVERED', () => {
      expect(contractExecutionTransition('MILESTONE_RUNNING', { type: 'deliver' })).toBe('MILESTONE_DELIVERED');
    });

    it('accept from MILESTONE_DELIVERED → MILESTONE_ACCEPTED', () => {
      expect(contractExecutionTransition('MILESTONE_DELIVERED', { type: 'accept' })).toBe('MILESTONE_ACCEPTED');
    });

    it('dispute from any → DISPUTE_OPEN', () => {
      expect(contractExecutionTransition('MILESTONE_RUNNING', { type: 'dispute' })).toBe('DISPUTE_OPEN');
    });
  });

  // ── Type check: new states exist in WorkflowState ───────────────────
  it('TASK_CLOSED is a valid WorkflowState value', () => {
    const state: WorkflowState = 'TASK_CLOSED';
    expect(state).toBe('TASK_CLOSED');
  });

  it('DISPUTE_AUTO_DECIDED is a valid WorkflowState value', () => {
    const state: WorkflowState = 'DISPUTE_AUTO_DECIDED';
    expect(state).toBe('DISPUTE_AUTO_DECIDED');
  });
});
