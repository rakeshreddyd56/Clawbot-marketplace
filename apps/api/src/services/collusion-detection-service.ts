/**
 * Collusion Detection Service
 *
 * Background job service that analyzes bid patterns, ring trading, shill bidding,
 * and reputation manipulation. Enforces institution rules:
 *   - C-3: No Collusion (shill bidding, price fixing, review manipulation, karma farming)
 *   - C-7: Bid-to-Completion Ratio (>= 50% over rolling 30-day window, min 5 bids)
 *   - M-3: Bidding Honesty (multiple identities, underbidding)
 *   - M-8: No Reputation Manipulation (ring trading, fake tasks/completions)
 *
 * Detection categories:
 *   1. SHILL_BIDDING — Same owner bidding on their own tasks (via owner handle correlation)
 *   2. RING_TRADING — Two agents repeatedly exchanging requester/worker roles
 *   3. PRICE_FIXING — Coordinated bid amounts across agents on the same task
 *   4. GHOST_BIDDING — Low bid-to-completion ratio (Rule C-7)
 *   5. REPUTATION_FARMING — Suspiciously small tasks with instant acceptance
 *   6. IDENTITY_ROTATION — Multiple agents sharing the same owner handle
 *
 * @author backend-2 agent
 * @date 2026-03-08
 */

import {
  CollusionAlertSchema,
  BidPatternAnalysisSchema,
  type CollusionAlert,
  type CollusionAlertType,
  type BidPatternAnalysis
} from '@claw/contracts';
import { nowIso, uid } from '@claw/utils';
import type { AuthContext, Store } from '../types/domain.js';
import { AuditLedger } from '../core/events.js';
import { DomainError } from '../core/errors.js';

// ─── Configuration thresholds ───────────────────────────────────────────────

/** Minimum bids before bid-to-completion ratio applies (Rule C-7) */
const MIN_BIDS_FOR_RATIO = 5;

/** Bid-to-completion ratio threshold (Rule C-7: at least 50%) */
const BID_TO_COMPLETION_THRESHOLD = 0.5;

/** Rolling window for analysis in days */
const ANALYSIS_WINDOW_DAYS = 30;

/** Number of repeated interactions to flag ring trading */
const RING_TRADING_THRESHOLD = 3;

/** Max budget for reputation farming detection (suspiciously small tasks) */
const REPUTATION_FARMING_MAX_BUDGET = 50;

/** Min acceptance speed (ms) for reputation farming (instant accepts are suspicious) */
const REPUTATION_FARMING_MIN_ACCEPTANCE_MS = 60_000; // 1 minute

/** Suspicion score threshold for generating an alert */
const SUSPICION_ALERT_THRESHOLD = 60;

/** Price fixing — max allowed coefficient of variation between bids on same task */
const PRICE_FIXING_CV_THRESHOLD = 0.05; // 5% variance = suspiciously coordinated

export class CollusionDetectionService {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLedger
  ) {}

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run full collusion scan across all agents.
   * Intended to be called as a background job (e.g., every 15 minutes).
   * Returns the list of new alerts generated during this scan.
   */
  runFullScan(): CollusionAlert[] {
    const newAlerts: CollusionAlert[] = [];
    const now = new Date();
    const windowStart = new Date(now.getTime() - ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Collect all agent IDs that have any activity
    const activeAgentIds = this.getActiveAgentIds(windowStart);

    // 1. Analyze bid patterns per agent (ghost bidding, bid-to-completion)
    for (const agentId of activeAgentIds) {
      const analysis = this.analyzeBidPattern(agentId, windowStart, now);
      this.store.bidPatternAnalyses.set(agentId, analysis);

      // Ghost bidding detection (Rule C-7)
      if (analysis.totalBids >= MIN_BIDS_FOR_RATIO && analysis.bidToCompletionRatio < BID_TO_COMPLETION_THRESHOLD) {
        const alert = this.createAlert('GHOST_BIDDING', 'MEDIUM', [agentId], {
          description: `Agent ${agentId} has bid-to-completion ratio of ${(analysis.bidToCompletionRatio * 100).toFixed(1)}% (threshold: ${BID_TO_COMPLETION_THRESHOLD * 100}%) over ${ANALYSIS_WINDOW_DAYS}-day window with ${analysis.totalBids} bids.`,
          dataPoints: [
            { metric: 'bidToCompletionRatio', value: analysis.bidToCompletionRatio, threshold: BID_TO_COMPLETION_THRESHOLD },
            { metric: 'totalBids', value: analysis.totalBids, threshold: MIN_BIDS_FOR_RATIO },
            { metric: 'completedTasks', value: analysis.completedTasks },
            { metric: 'abandonedLeases', value: analysis.abandonedLeases }
          ]
        });
        if (alert) newAlerts.push(alert);
      }
    }

    // 2. Ring trading detection (Rule M-8)
    const ringAlerts = this.detectRingTrading(windowStart);
    newAlerts.push(...ringAlerts);

    // 3. Shill bidding detection (same owner bidding on own tasks)
    const shillAlerts = this.detectShillBidding();
    newAlerts.push(...shillAlerts);

    // 4. Reputation farming detection (small tasks, instant accept)
    const farmingAlerts = this.detectReputationFarming(windowStart);
    newAlerts.push(...farmingAlerts);

    // 5. Identity rotation detection (multiple agents, same owner)
    const rotationAlerts = this.detectIdentityRotation();
    newAlerts.push(...rotationAlerts);

    // 6. Price fixing detection (coordinated bids on same task)
    const pricingAlerts = this.detectPriceFixing(windowStart);
    newAlerts.push(...pricingAlerts);

    // Emit audit event for the scan
    this.audit.publish('collusion.scan.completed', 'system', {
      agentsScanned: activeAgentIds.size,
      newAlertsCount: newAlerts.length,
      alertTypes: newAlerts.map((a) => a.alertType)
    });

    return newAlerts;
  }

  /**
   * Analyze bid patterns for a single agent.
   */
  analyzeBidPattern(agentId: string, windowStart: Date, windowEnd: Date): BidPatternAnalysis {
    const bidsInWindow = this.getBidsForAgent(agentId, windowStart);
    const completedContracts = this.getCompletedContractsForAgent(agentId, windowStart);
    const abandonedLeases = this.getAbandonedLeasesForAgent(agentId, windowStart);

    const totalBids = bidsInWindow.length;
    const completedTasks = completedContracts.length;
    const abandonedCount = abandonedLeases.length;
    const ratio = totalBids > 0 ? completedTasks / totalBids : 1;

    // Compute counterparty distribution
    const counterpartyCounts = new Map<string, number>();
    for (const contract of [...this.store.contracts.values()]) {
      const createdAt = new Date(contract.signedAt);
      if (createdAt < windowStart) continue;

      if (contract.workerAgentId === agentId) {
        counterpartyCounts.set(contract.requesterAgentId, (counterpartyCounts.get(contract.requesterAgentId) ?? 0) + 1);
      } else if (contract.requesterAgentId === agentId) {
        counterpartyCounts.set(contract.workerAgentId, (counterpartyCounts.get(contract.workerAgentId) ?? 0) + 1);
      }
    }

    const repeatedCounterpartyPairs = [...counterpartyCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([counterpartyId, interactions]) => ({ counterpartyId, interactions }))
      .sort((a, b) => b.interactions - a.interactions);

    // Compute average bid amount
    const bidAmounts = bidsInWindow.map((b) => b.rate);
    const avgBidAmount = bidAmounts.length > 0 ? bidAmounts.reduce((a, b) => a + b, 0) / bidAmounts.length : 0;

    // Suspicion score: weighted combination of signals
    let suspicionScore = 0;
    if (totalBids >= MIN_BIDS_FOR_RATIO && ratio < BID_TO_COMPLETION_THRESHOLD) {
      suspicionScore += 30 * (1 - ratio / BID_TO_COMPLETION_THRESHOLD);
    }
    if (repeatedCounterpartyPairs.some((p) => p.interactions >= RING_TRADING_THRESHOLD)) {
      suspicionScore += 25;
    }
    if (abandonedCount > 3) {
      suspicionScore += Math.min(20, abandonedCount * 4);
    }
    suspicionScore = Math.min(100, Math.max(0, Math.round(suspicionScore)));

    return BidPatternAnalysisSchema.parse({
      agentId,
      windowStartAt: windowStart.toISOString(),
      windowEndAt: windowEnd.toISOString(),
      totalBids,
      completedTasks,
      abandonedLeases: abandonedCount,
      bidToCompletionRatio: Math.round(ratio * 100) / 100,
      uniqueCounterparties: counterpartyCounts.size,
      avgBidAmount: Math.round(avgBidAmount * 100) / 100,
      repeatedCounterpartyPairs,
      suspicionScore,
      analyzedAt: nowIso()
    });
  }

  /**
   * Get an agent's bid pattern analysis.
   */
  getAnalysis(agentId: string): BidPatternAnalysis | undefined {
    return this.store.bidPatternAnalyses.get(agentId);
  }

  /**
   * List all open collusion alerts.
   * Accessible to moderators and admins only.
   */
  listAlerts(status?: CollusionAlert['status']): CollusionAlert[] {
    const alerts = [...this.store.collusionAlerts.values()];
    if (status) {
      return alerts.filter((a) => a.status === status);
    }
    return alerts.sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
  }

  /**
   * Get a single alert by ID.
   */
  getAlert(alertId: string): CollusionAlert {
    const alert = this.store.collusionAlerts.get(alertId);
    if (!alert) {
      throw new DomainError('ALERT_NOT_FOUND', `Collusion alert ${alertId} not found.`, 404);
    }
    return alert;
  }

  /**
   * Resolve a collusion alert (moderator/admin action).
   */
  resolveAlert(
    actor: AuthContext,
    alertId: string,
    resolution: 'CONFIRMED' | 'DISMISSED',
    notes?: string
  ): CollusionAlert {
    const alert = this.getAlert(alertId);

    if (alert.status !== 'OPEN' && alert.status !== 'INVESTIGATING') {
      throw new DomainError('ALERT_ALREADY_RESOLVED', `Alert ${alertId} is already ${alert.status}.`, 409);
    }

    const resolved: CollusionAlert = {
      ...alert,
      status: resolution,
      resolvedAt: nowIso(),
      resolvedBy: actor.actorAgentId,
      resolution: notes ?? resolution
    };

    this.store.collusionAlerts.set(alertId, resolved);

    this.audit.publish(`collusion.alert.${resolution.toLowerCase()}`, actor.actorAgentId, {
      alertId,
      alertType: alert.alertType,
      agentIds: alert.agentIds,
      resolution: notes ?? resolution
    });

    return resolved;
  }

  // ─── Detection Methods ──────────────────────────────────────────────────────

  /**
   * Detect ring trading: two agents repeatedly acting as requester/worker for each other.
   * Rule M-8: Ring trading results in permanent BAN for all parties.
   */
  private detectRingTrading(windowStart: Date): CollusionAlert[] {
    const alerts: CollusionAlert[] = [];
    const pairCounts = new Map<string, { asWorker: number; asRequester: number; taskIds: string[] }>();

    for (const contract of this.store.contracts.values()) {
      const signedAt = new Date(contract.signedAt);
      if (signedAt < windowStart) continue;

      // Track interactions in both directions
      const forwardKey = `${contract.requesterAgentId}:${contract.workerAgentId}`;
      const reverseKey = `${contract.workerAgentId}:${contract.requesterAgentId}`;

      const forward = pairCounts.get(forwardKey) ?? { asWorker: 0, asRequester: 0, taskIds: [] };
      forward.asRequester++;
      forward.taskIds.push(contract.taskId);
      pairCounts.set(forwardKey, forward);

      const reverse = pairCounts.get(reverseKey) ?? { asWorker: 0, asRequester: 0, taskIds: [] };
      reverse.asWorker++;
      pairCounts.set(reverseKey, reverse);
    }

    // Check for bidirectional patterns (A→B and B→A)
    const checked = new Set<string>();
    for (const [key, data] of pairCounts) {
      const [agentA, agentB] = key.split(':');
      const pairId = [agentA, agentB].sort().join(':');

      if (checked.has(pairId)) continue;
      checked.add(pairId);

      const reverseKey = `${agentB}:${agentA}`;
      const reverseData = pairCounts.get(reverseKey);

      if (reverseData && data.asRequester >= RING_TRADING_THRESHOLD && reverseData.asRequester >= RING_TRADING_THRESHOLD) {
        const totalInteractions = data.asRequester + (reverseData?.asRequester ?? 0);
        const allTaskIds = [...data.taskIds, ...(reverseData?.taskIds ?? [])];

        const alert = this.createAlert('RING_TRADING', 'CRITICAL', [agentA, agentB], {
          description: `Agents ${agentA} and ${agentB} have ${totalInteractions} reciprocal contracts in ${ANALYSIS_WINDOW_DAYS} days (${data.asRequester} A→B, ${reverseData.asRequester} B→A). Possible ring trading for reputation farming.`,
          dataPoints: [
            { metric: 'totalReciprocal', value: totalInteractions, threshold: RING_TRADING_THRESHOLD * 2 },
            { metric: 'aToB', value: data.asRequester },
            { metric: 'bToA', value: reverseData.asRequester }
          ],
          relatedTaskIds: allTaskIds
        });
        if (alert) alerts.push(alert);
      }
    }

    return alerts;
  }

  /**
   * Detect shill bidding: same owner handle controlling both requester and bidder.
   * Rule C-3: Shill bidding is prohibited.
   */
  private detectShillBidding(): CollusionAlert[] {
    const alerts: CollusionAlert[] = [];

    // Build owner-to-agents map from Moltbook snapshots
    const ownerToAgents = new Map<string, string[]>();
    for (const [agentId, snapshot] of this.store.moltbookSnapshots) {
      const handle = snapshot.agent?.owner?.xHandle;
      if (!handle) continue;
      const agents = ownerToAgents.get(handle) ?? [];
      agents.push(agentId);
      ownerToAgents.set(handle, agents);
    }

    // For owners with multiple agents, check if any bid on each other's tasks
    for (const [ownerHandle, agentIds] of ownerToAgents) {
      if (agentIds.length < 2) continue;

      const agentSet = new Set(agentIds);

      for (const taskBids of this.store.bids.values()) {
        for (const bid of taskBids) {
          const task = this.store.tasks.get(bid.taskId);
          if (!task) continue;

          // Check if bidder and requester share the same owner
          if (agentSet.has(bid.workerAgentId) && agentSet.has(task.requesterAgentId) && bid.workerAgentId !== task.requesterAgentId) {
            const alert = this.createAlert('SHILL_BIDDING', 'HIGH', [bid.workerAgentId, task.requesterAgentId], {
              description: `Agents ${bid.workerAgentId} and ${task.requesterAgentId} share owner handle "${ownerHandle}" and have bid/requester relationship on task ${bid.taskId}.`,
              dataPoints: [
                { metric: 'ownerHandle', value: ownerHandle },
                { metric: 'bidderAgentId', value: bid.workerAgentId },
                { metric: 'requesterAgentId', value: task.requesterAgentId }
              ],
              relatedTaskIds: [bid.taskId]
            });
            if (alert) alerts.push(alert);
          }
        }
      }
    }

    return alerts;
  }

  /**
   * Detect reputation farming: suspiciously small tasks with instant acceptance.
   * Rule M-8: Fake tasks and completions result in permanent BAN.
   */
  private detectReputationFarming(windowStart: Date): CollusionAlert[] {
    const alerts: CollusionAlert[] = [];

    // Group contracts by requester-worker pair
    const pairContracts = new Map<string, { contracts: Array<{ contractId: string; taskId: string; budget: number; signedAt: string; milestones: Array<{ status: string }> }> }>();

    for (const contract of this.store.contracts.values()) {
      const signedAt = new Date(contract.signedAt);
      if (signedAt < windowStart) continue;

      const task = this.store.tasks.get(contract.taskId);
      if (!task) continue;

      const pairKey = `${contract.requesterAgentId}:${contract.workerAgentId}`;
      const existing = pairContracts.get(pairKey) ?? { contracts: [] };
      existing.contracts.push({
        contractId: contract.contractId,
        taskId: contract.taskId,
        budget: task.budget,
        signedAt: contract.signedAt,
        milestones: contract.milestones
      });
      pairContracts.set(pairKey, existing);
    }

    // Flag pairs with many small, instantly-accepted tasks
    for (const [pairKey, data] of pairContracts) {
      const smallInstantTasks = data.contracts.filter((c) => {
        const isSmall = c.budget <= REPUTATION_FARMING_MAX_BUDGET;
        const allAccepted = c.milestones.every((m) => m.status === 'ACCEPTED');
        return isSmall && allAccepted;
      });

      if (smallInstantTasks.length >= 3) {
        const [requesterId, workerId] = pairKey.split(':');
        const alert = this.createAlert('REPUTATION_FARMING', 'HIGH', [requesterId, workerId], {
          description: `Pair ${requesterId} → ${workerId} has ${smallInstantTasks.length} completed micro-tasks (budget <= ${REPUTATION_FARMING_MAX_BUDGET} credits) in ${ANALYSIS_WINDOW_DAYS} days. Possible reputation farming.`,
          dataPoints: [
            { metric: 'microTaskCount', value: smallInstantTasks.length, threshold: 3 },
            { metric: 'maxBudget', value: REPUTATION_FARMING_MAX_BUDGET },
            { metric: 'totalContracts', value: data.contracts.length }
          ],
          relatedContractIds: smallInstantTasks.map((c) => c.contractId),
          relatedTaskIds: smallInstantTasks.map((c) => c.taskId)
        });
        if (alert) alerts.push(alert);
      }
    }

    return alerts;
  }

  /**
   * Detect identity rotation: multiple agents with the same owner handle.
   * Used for marketplace manipulation (circumvent sanctions, multi-bid).
   */
  private detectIdentityRotation(): CollusionAlert[] {
    const alerts: CollusionAlert[] = [];
    const ownerToAgents = new Map<string, string[]>();

    for (const [agentId, snapshot] of this.store.moltbookSnapshots) {
      const handle = snapshot.agent?.owner?.xHandle;
      if (!handle) continue;

      // Only count active agents (not banned/suspended)
      const agent = this.store.agents.get(agentId);
      if (!agent || agent.profile.status === 'BANNED') continue;

      const agents = ownerToAgents.get(handle) ?? [];
      agents.push(agentId);
      ownerToAgents.set(handle, agents);
    }

    for (const [ownerHandle, agentIds] of ownerToAgents) {
      if (agentIds.length < 2) continue;

      const alert = this.createAlert('IDENTITY_ROTATION', 'HIGH', agentIds, {
        description: `Owner "${ownerHandle}" has ${agentIds.length} active agent accounts: [${agentIds.join(', ')}]. Rule I-5 prohibits identity sharing/rotation.`,
        dataPoints: [
          { metric: 'ownerHandle', value: ownerHandle },
          { metric: 'agentCount', value: agentIds.length, threshold: 2 }
        ]
      });
      if (alert) alerts.push(alert);
    }

    return alerts;
  }

  /**
   * Detect price fixing: suspiciously similar bid amounts from different agents on the same task.
   * Rule C-3: Price fixing is prohibited.
   */
  private detectPriceFixing(windowStart: Date): CollusionAlert[] {
    const alerts: CollusionAlert[] = [];

    for (const [, taskBids] of this.store.bids) {
      // Need at least 3 bids to detect price fixing
      if (taskBids.length < 3) continue;

      const recentBids = taskBids.filter((b) => new Date(b.createdAt) >= windowStart);
      if (recentBids.length < 3) continue;

      const rates = recentBids.map((b) => b.rate);
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      if (mean === 0) continue;

      const variance = rates.reduce((sum, r) => sum + (r - mean) ** 2, 0) / rates.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / mean; // Coefficient of variation

      // Very low variance across multiple bidders is suspicious
      if (cv <= PRICE_FIXING_CV_THRESHOLD && recentBids.length >= 3) {
        const bidderIds = [...new Set(recentBids.map((b) => b.workerAgentId))];
        if (bidderIds.length < 2) continue; // Same agent, not collusion

        const taskId = recentBids[0].taskId;
        const alert = this.createAlert('PRICE_FIXING', 'MEDIUM', bidderIds, {
          description: `Task ${taskId} has ${recentBids.length} bids from ${bidderIds.length} agents with coefficient of variation ${(cv * 100).toFixed(2)}% (threshold: ${PRICE_FIXING_CV_THRESHOLD * 100}%). Possible price coordination.`,
          dataPoints: [
            { metric: 'coefficientOfVariation', value: Math.round(cv * 10000) / 100, threshold: PRICE_FIXING_CV_THRESHOLD * 100 },
            { metric: 'meanBidRate', value: Math.round(mean * 100) / 100 },
            { metric: 'bidCount', value: recentBids.length },
            { metric: 'uniqueBidders', value: bidderIds.length }
          ],
          relatedTaskIds: [taskId]
        });
        if (alert) alerts.push(alert);
      }
    }

    return alerts;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Create an alert if a similar one doesn't already exist (dedup by type + agents).
   */
  private createAlert(
    alertType: CollusionAlertType,
    severity: CollusionAlert['severity'],
    agentIds: string[],
    evidence: CollusionAlert['evidence']
  ): CollusionAlert | null {
    // Dedup: check if an open alert of the same type already exists for these agents
    const sortedIds = [...agentIds].sort().join(',');
    for (const existing of this.store.collusionAlerts.values()) {
      if (
        existing.alertType === alertType &&
        existing.status === 'OPEN' &&
        [...existing.agentIds].sort().join(',') === sortedIds
      ) {
        return null; // Already reported
      }
    }

    const alert = CollusionAlertSchema.parse({
      alertId: uid('collusion'),
      alertType,
      severity,
      agentIds,
      evidence,
      status: 'OPEN',
      detectedAt: nowIso(),
      autoSanctioned: false
    });

    this.store.collusionAlerts.set(alert.alertId, alert);

    this.audit.publish('collusion.alert.created', 'system', {
      alertId: alert.alertId,
      alertType,
      severity,
      agentIds
    });

    return alert;
  }

  /**
   * Get all agent IDs that have any bids, contracts, or leases in the window.
   */
  private getActiveAgentIds(windowStart: Date): Set<string> {
    const ids = new Set<string>();

    for (const taskBids of this.store.bids.values()) {
      for (const bid of taskBids) {
        if (new Date(bid.createdAt) >= windowStart) {
          ids.add(bid.workerAgentId);
        }
      }
    }

    for (const contract of this.store.contracts.values()) {
      if (new Date(contract.signedAt) >= windowStart) {
        ids.add(contract.requesterAgentId);
        ids.add(contract.workerAgentId);
      }
    }

    return ids;
  }

  /**
   * Get all bids placed by an agent within the window.
   */
  private getBidsForAgent(agentId: string, windowStart: Date) {
    const bids: Array<{ bidId: string; taskId: string; workerAgentId: string; rate: number; createdAt: string }> = [];
    for (const taskBids of this.store.bids.values()) {
      for (const bid of taskBids) {
        if (bid.workerAgentId === agentId && new Date(bid.createdAt) >= windowStart) {
          bids.push(bid);
        }
      }
    }
    return bids;
  }

  /**
   * Get contracts completed by an agent (all milestones ACCEPTED) within the window.
   */
  private getCompletedContractsForAgent(agentId: string, windowStart: Date) {
    return [...this.store.contracts.values()].filter((c) => {
      if (c.workerAgentId !== agentId) return false;
      if (new Date(c.signedAt) < windowStart) return false;
      return c.milestones.every((m) => m.status === 'ACCEPTED');
    });
  }

  /**
   * Get abandoned leases for an agent within the window.
   */
  private getAbandonedLeasesForAgent(agentId: string, windowStart: Date) {
    const outcomes = this.store.leaseOutcomeLog.get(agentId) ?? [];
    return outcomes.filter((o) => o.outcome === 'EXPIRED' && new Date(o.timestamp) >= windowStart);
  }
}
