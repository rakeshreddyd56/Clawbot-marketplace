/**
 * Tests for CollusionDetectionService
 *
 * Tests the background job service that detects:
 * - Ghost bidding (low bid-to-completion ratio, Rule C-7)
 * - Ring trading (reciprocal task exchange, Rule M-8)
 * - Shill bidding (same owner bidding on own tasks, Rule C-3)
 * - Reputation farming (micro-tasks with instant accept, Rule M-8)
 * - Identity rotation (multiple agents with same owner, Rule I-5)
 * - Price fixing (coordinated bid amounts, Rule C-3)
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createStore } from '../src/core/store.js';
import { AuditLedger } from '../src/core/events.js';
import { CollusionDetectionService } from '../src/services/collusion-detection-service.js';
import type { Store } from '../src/types/domain.js';
import { nowIso, uid } from '@claw/utils';

function makeSnapshot(agentId: string, ownerHandle: string) {
  return {
    valid: true,
    checkedAt: nowIso(),
    trustedUntilAt: new Date(Date.now() + 50 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    trustTier: 'A' as const,
    hardBlocked: false,
    blockReasons: [],
    agent: {
      id: agentId,
      name: `Agent ${agentId}`,
      karma: 200,
      isClaimed: true,
      stats: { posts: 100, comments: 100 },
      owner: { xVerified: true, xHandle: ownerHandle }
    }
  };
}

function makeContract(
  store: Store,
  contractId: string,
  taskId: string,
  requesterId: string,
  workerId: string,
  milestonesAccepted: boolean = false
) {
  store.contracts.set(contractId, {
    contractId,
    taskId,
    requesterAgentId: requesterId,
    workerAgentId: workerId,
    penaltySchedule: { latePenaltyPct: 10, disputeSlashPct: 20 },
    constitutionVersion: 'v2.1',
    signedAt: nowIso(),
    milestones: [
      {
        milestoneId: uid('ms'),
        contractId,
        name: 'Milestone 1',
        amountCredits: 100,
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        acceptanceRuleRef: 'test',
        status: milestonesAccepted ? 'ACCEPTED' : 'PENDING'
      }
    ]
  });
}

function makeBid(store: Store, taskId: string, workerId: string, rate: number) {
  const existing = store.bids.get(taskId) ?? [];
  existing.push({
    bidId: uid('bid'),
    taskId,
    workerAgentId: workerId,
    rate,
    createdAt: nowIso()
  });
  store.bids.set(taskId, existing);
}

function makeTask(store: Store, taskId: string, requesterId: string, budget: number = 500) {
  store.tasks.set(taskId, {
    taskId,
    requesterAgentId: requesterId,
    title: 'Test Task',
    description: 'Test task description',
    pricingMode: 'fixed',
    budget,
    deadlineAt: new Date(Date.now() + 86400000).toISOString(),
    visibility: 'public',
    status: 'POSTED',
    scopeManifestId: uid('scope'),
    createdAt: nowIso()
  });
}

function makeAgent(store: Store, agentId: string) {
  store.agents.set(agentId, {
    profile: {
      agentId,
      moltbookAgentId: agentId,
      ownerRef: `owner_${agentId}`,
      verificationStatus: 'VERIFIED',
      status: 'ACTIVE',
      riskTier: 'LOW',
      kycTier: 'NONE',
      createdAt: nowIso()
    }
  });
}

describe('CollusionDetectionService', () => {
  let store: Store;
  let audit: AuditLedger;
  let service: CollusionDetectionService;

  beforeEach(() => {
    store = createStore();
    audit = new AuditLedger();
    service = new CollusionDetectionService(store, audit);
  });

  describe('Ghost Bidding Detection (Rule C-7)', () => {
    it('flags agent with bid-to-completion ratio below 50%', () => {
      const agentId = 'ghost_worker';
      makeAgent(store, agentId);

      // Create 6 bids but no completed contracts
      for (let i = 0; i < 6; i++) {
        const taskId = `task_${i}`;
        makeTask(store, taskId, 'requester_1');
        makeBid(store, taskId, agentId, 100);
      }

      const alerts = service.runFullScan();
      const ghostAlerts = alerts.filter((a) => a.alertType === 'GHOST_BIDDING');
      expect(ghostAlerts.length).toBe(1);
      expect(ghostAlerts[0].agentIds).toContain(agentId);
      expect(ghostAlerts[0].severity).toBe('MEDIUM');
    });

    it('does not flag agent with sufficient completion ratio', () => {
      const agentId = 'good_worker';
      makeAgent(store, agentId);

      // 6 bids, 4 completed (67% > 50%)
      for (let i = 0; i < 6; i++) {
        const taskId = `task_${i}`;
        makeTask(store, taskId, 'requester_1');
        makeBid(store, taskId, agentId, 100);
        if (i < 4) {
          makeContract(store, `contract_${i}`, taskId, 'requester_1', agentId, true);
        }
      }

      const alerts = service.runFullScan();
      const ghostAlerts = alerts.filter((a) => a.alertType === 'GHOST_BIDDING');
      expect(ghostAlerts.length).toBe(0);
    });

    it('does not flag agent with fewer than 5 bids (min threshold)', () => {
      const agentId = 'few_bids_worker';
      makeAgent(store, agentId);

      // 3 bids, 0 completed — ratio is bad but below min threshold
      for (let i = 0; i < 3; i++) {
        const taskId = `task_${i}`;
        makeTask(store, taskId, 'requester_1');
        makeBid(store, taskId, agentId, 100);
      }

      const alerts = service.runFullScan();
      const ghostAlerts = alerts.filter((a) => a.alertType === 'GHOST_BIDDING');
      expect(ghostAlerts.length).toBe(0);
    });
  });

  describe('Ring Trading Detection (Rule M-8)', () => {
    it('detects reciprocal task exchange between two agents', () => {
      const agentA = 'ring_a';
      const agentB = 'ring_b';
      makeAgent(store, agentA);
      makeAgent(store, agentB);

      // A→B: 3 contracts
      for (let i = 0; i < 3; i++) {
        const taskId = `task_a2b_${i}`;
        makeTask(store, taskId, agentA);
        makeContract(store, `contract_a2b_${i}`, taskId, agentA, agentB, true);
      }

      // B→A: 3 contracts
      for (let i = 0; i < 3; i++) {
        const taskId = `task_b2a_${i}`;
        makeTask(store, taskId, agentB);
        makeContract(store, `contract_b2a_${i}`, taskId, agentB, agentA, true);
      }

      const alerts = service.runFullScan();
      const ringAlerts = alerts.filter((a) => a.alertType === 'RING_TRADING');
      expect(ringAlerts.length).toBe(1);
      expect(ringAlerts[0].severity).toBe('CRITICAL');
      expect(ringAlerts[0].agentIds).toContain(agentA);
      expect(ringAlerts[0].agentIds).toContain(agentB);
    });

    it('does not flag non-reciprocal relationships', () => {
      const agentA = 'oneway_a';
      const agentB = 'oneway_b';
      makeAgent(store, agentA);
      makeAgent(store, agentB);

      // Only A→B, no B→A
      for (let i = 0; i < 5; i++) {
        const taskId = `task_${i}`;
        makeTask(store, taskId, agentA);
        makeContract(store, `contract_${i}`, taskId, agentA, agentB, true);
      }

      const alerts = service.runFullScan();
      const ringAlerts = alerts.filter((a) => a.alertType === 'RING_TRADING');
      expect(ringAlerts.length).toBe(0);
    });
  });

  describe('Shill Bidding Detection (Rule C-3)', () => {
    it('detects when two agents with same owner bid on each others tasks', () => {
      const agentA = 'shill_a';
      const agentB = 'shill_b';
      makeAgent(store, agentA);
      makeAgent(store, agentB);

      // Both share the same owner handle
      store.moltbookSnapshots.set(agentA, makeSnapshot(agentA, 'shared_owner'));
      store.moltbookSnapshots.set(agentB, makeSnapshot(agentB, 'shared_owner'));

      // A posts a task, B bids on it
      const taskId = 'shill_task';
      makeTask(store, taskId, agentA);
      makeBid(store, taskId, agentB, 100);

      const alerts = service.runFullScan();
      const shillAlerts = alerts.filter((a) => a.alertType === 'SHILL_BIDDING');
      expect(shillAlerts.length).toBe(1);
      expect(shillAlerts[0].severity).toBe('HIGH');
    });

    it('does not flag agents with different owners', () => {
      const agentA = 'legit_a';
      const agentB = 'legit_b';
      makeAgent(store, agentA);
      makeAgent(store, agentB);

      store.moltbookSnapshots.set(agentA, makeSnapshot(agentA, 'owner_a'));
      store.moltbookSnapshots.set(agentB, makeSnapshot(agentB, 'owner_b'));

      const taskId = 'legit_task';
      makeTask(store, taskId, agentA);
      makeBid(store, taskId, agentB, 100);

      const alerts = service.runFullScan();
      const shillAlerts = alerts.filter((a) => a.alertType === 'SHILL_BIDDING');
      expect(shillAlerts.length).toBe(0);
    });
  });

  describe('Reputation Farming Detection (Rule M-8)', () => {
    it('detects repeated micro-tasks between the same pair', () => {
      const requester = 'farm_requester';
      const worker = 'farm_worker';
      makeAgent(store, requester);
      makeAgent(store, worker);

      // Create 4 micro-tasks (budget <= 50) with all milestones accepted
      for (let i = 0; i < 4; i++) {
        const taskId = `micro_${i}`;
        makeTask(store, taskId, requester, 30);
        makeContract(store, `micro_contract_${i}`, taskId, requester, worker, true);
      }

      const alerts = service.runFullScan();
      const farmAlerts = alerts.filter((a) => a.alertType === 'REPUTATION_FARMING');
      expect(farmAlerts.length).toBe(1);
      expect(farmAlerts[0].severity).toBe('HIGH');
    });

    it('does not flag normal-sized tasks', () => {
      const requester = 'normal_requester';
      const worker = 'normal_worker';
      makeAgent(store, requester);
      makeAgent(store, worker);

      for (let i = 0; i < 4; i++) {
        const taskId = `normal_${i}`;
        makeTask(store, taskId, requester, 500);
        makeContract(store, `normal_contract_${i}`, taskId, requester, worker, true);
      }

      const alerts = service.runFullScan();
      const farmAlerts = alerts.filter((a) => a.alertType === 'REPUTATION_FARMING');
      expect(farmAlerts.length).toBe(0);
    });
  });

  describe('Identity Rotation Detection (Rule I-5)', () => {
    it('detects multiple active agents with the same owner', () => {
      const agents = ['rot_a', 'rot_b', 'rot_c'];
      for (const id of agents) {
        makeAgent(store, id);
        store.moltbookSnapshots.set(id, makeSnapshot(id, 'same_human_owner'));
      }

      const alerts = service.runFullScan();
      const rotAlerts = alerts.filter((a) => a.alertType === 'IDENTITY_ROTATION');
      expect(rotAlerts.length).toBe(1);
      expect(rotAlerts[0].agentIds.length).toBe(3);
    });

    it('excludes banned agents from rotation detection', () => {
      makeAgent(store, 'active_1');
      store.moltbookSnapshots.set('active_1', makeSnapshot('active_1', 'same_owner'));

      // Make a second agent but mark it as BANNED
      store.agents.set('banned_1', {
        profile: {
          agentId: 'banned_1',
          moltbookAgentId: 'banned_1',
          ownerRef: 'owner_banned',
          verificationStatus: 'VERIFIED',
          status: 'BANNED',
          riskTier: 'LOW',
          kycTier: 'NONE',
          createdAt: nowIso()
        }
      });
      store.moltbookSnapshots.set('banned_1', makeSnapshot('banned_1', 'same_owner'));

      const alerts = service.runFullScan();
      const rotAlerts = alerts.filter((a) => a.alertType === 'IDENTITY_ROTATION');
      expect(rotAlerts.length).toBe(0); // Only 1 active agent, no rotation
    });
  });

  describe('Price Fixing Detection (Rule C-3)', () => {
    it('detects suspiciously similar bid amounts on the same task', () => {
      const taskId = 'price_task';
      makeTask(store, taskId, 'requester_1');

      // 4 different agents bidding nearly identical amounts (CV < 5%)
      makeBid(store, taskId, 'worker_a', 100);
      makeBid(store, taskId, 'worker_b', 100);
      makeBid(store, taskId, 'worker_c', 101);
      makeBid(store, taskId, 'worker_d', 100);

      const alerts = service.runFullScan();
      const priceAlerts = alerts.filter((a) => a.alertType === 'PRICE_FIXING');
      expect(priceAlerts.length).toBe(1);
      expect(priceAlerts[0].severity).toBe('MEDIUM');
    });

    it('does not flag varied bid amounts', () => {
      const taskId = 'varied_task';
      makeTask(store, taskId, 'requester_1');

      // Diverse bid amounts (high variance)
      makeBid(store, taskId, 'worker_a', 50);
      makeBid(store, taskId, 'worker_b', 200);
      makeBid(store, taskId, 'worker_c', 120);
      makeBid(store, taskId, 'worker_d', 80);

      const alerts = service.runFullScan();
      const priceAlerts = alerts.filter((a) => a.alertType === 'PRICE_FIXING');
      expect(priceAlerts.length).toBe(0);
    });
  });

  describe('Alert Management', () => {
    it('deduplicates alerts with same type and agents', () => {
      const agentA = 'dedup_a';
      const agentB = 'dedup_b';
      makeAgent(store, agentA);
      makeAgent(store, agentB);

      store.moltbookSnapshots.set(agentA, makeSnapshot(agentA, 'dedup_owner'));
      store.moltbookSnapshots.set(agentB, makeSnapshot(agentB, 'dedup_owner'));

      const taskId = 'dedup_task';
      makeTask(store, taskId, agentA);
      makeBid(store, taskId, agentB, 100);

      // Run scan twice
      const alerts1 = service.runFullScan();
      const alerts2 = service.runFullScan();

      // Should not duplicate the alert
      const shillAlerts1 = alerts1.filter((a) => a.alertType === 'SHILL_BIDDING');
      const shillAlerts2 = alerts2.filter((a) => a.alertType === 'SHILL_BIDDING');
      expect(shillAlerts1.length).toBe(1);
      expect(shillAlerts2.length).toBe(0); // Deduped

      // Total should still be 1
      const all = service.listAlerts('OPEN');
      const shillAll = all.filter((a) => a.alertType === 'SHILL_BIDDING');
      expect(shillAll.length).toBe(1);
    });

    it('resolves an alert as CONFIRMED', () => {
      const agentA = 'resolve_a';
      const agentB = 'resolve_b';
      makeAgent(store, agentA);
      makeAgent(store, agentB);

      store.moltbookSnapshots.set(agentA, makeSnapshot(agentA, 'resolve_owner'));
      store.moltbookSnapshots.set(agentB, makeSnapshot(agentB, 'resolve_owner'));

      makeTask(store, 'resolve_task', agentA);
      makeBid(store, 'resolve_task', agentB, 100);

      service.runFullScan();
      const openAlerts = service.listAlerts('OPEN');
      expect(openAlerts.length).toBeGreaterThan(0);

      const alertId = openAlerts[0].alertId;
      const resolved = service.resolveAlert(
        { actorAgentId: 'mod_1', role: 'moderator' },
        alertId,
        'CONFIRMED',
        'Investigation confirmed collusion'
      );

      expect(resolved.status).toBe('CONFIRMED');
      expect(resolved.resolvedBy).toBe('mod_1');
      expect(resolved.resolvedAt).toBeDefined();
    });

    it('resolves an alert as DISMISSED', () => {
      const agentA = 'dismiss_a';
      const agentB = 'dismiss_b';
      makeAgent(store, agentA);
      makeAgent(store, agentB);

      store.moltbookSnapshots.set(agentA, makeSnapshot(agentA, 'dismiss_owner'));
      store.moltbookSnapshots.set(agentB, makeSnapshot(agentB, 'dismiss_owner'));

      makeTask(store, 'dismiss_task', agentA);
      makeBid(store, 'dismiss_task', agentB, 100);

      service.runFullScan();
      const openAlerts = service.listAlerts('OPEN');
      const alertId = openAlerts[0].alertId;

      const dismissed = service.resolveAlert(
        { actorAgentId: 'admin_1', role: 'admin' },
        alertId,
        'DISMISSED',
        'False positive — agents are in legitimate partnership'
      );

      expect(dismissed.status).toBe('DISMISSED');
    });

    it('throws on resolving already-resolved alert', () => {
      const agentA = 'dbl_a';
      const agentB = 'dbl_b';
      makeAgent(store, agentA);
      makeAgent(store, agentB);

      store.moltbookSnapshots.set(agentA, makeSnapshot(agentA, 'dbl_owner'));
      store.moltbookSnapshots.set(agentB, makeSnapshot(agentB, 'dbl_owner'));

      makeTask(store, 'dbl_task', agentA);
      makeBid(store, 'dbl_task', agentB, 100);

      service.runFullScan();
      const alertId = service.listAlerts('OPEN')[0].alertId;
      service.resolveAlert({ actorAgentId: 'mod', role: 'moderator' }, alertId, 'CONFIRMED');

      expect(() =>
        service.resolveAlert({ actorAgentId: 'mod', role: 'moderator' }, alertId, 'DISMISSED')
      ).toThrow('already');
    });

    it('emits audit events on scan and alert creation', () => {
      makeAgent(store, 'audit_a');
      makeAgent(store, 'audit_b');
      store.moltbookSnapshots.set('audit_a', makeSnapshot('audit_a', 'audit_owner'));
      store.moltbookSnapshots.set('audit_b', makeSnapshot('audit_b', 'audit_owner'));

      makeTask(store, 'audit_task', 'audit_a');
      makeBid(store, 'audit_task', 'audit_b', 100);

      service.runFullScan();

      const events = audit.getAll();
      const scanEvents = events.filter((e) => e.eventType === 'collusion.scan.completed');
      const alertEvents = events.filter((e) => e.eventType === 'collusion.alert.created');

      expect(scanEvents.length).toBe(1);
      expect(alertEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Bid Pattern Analysis', () => {
    it('computes analysis for an agent', () => {
      const agentId = 'analysis_worker';
      makeAgent(store, agentId);

      // 5 bids, 2 completed
      for (let i = 0; i < 5; i++) {
        const taskId = `analysis_task_${i}`;
        makeTask(store, taskId, 'requester_1');
        makeBid(store, taskId, agentId, 100 + i * 10);
        if (i < 2) {
          makeContract(store, `analysis_contract_${i}`, taskId, 'requester_1', agentId, true);
        }
      }

      service.runFullScan();
      const analysis = service.getAnalysis(agentId);
      expect(analysis).toBeDefined();
      expect(analysis!.totalBids).toBe(5);
      expect(analysis!.completedTasks).toBe(2);
      expect(analysis!.bidToCompletionRatio).toBe(0.4);
      expect(analysis!.avgBidAmount).toBeGreaterThan(0);
    });
  });
});
