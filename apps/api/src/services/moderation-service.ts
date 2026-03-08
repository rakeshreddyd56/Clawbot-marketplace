/**
 * TASK-HARD-012: Owner mismatch moderator review workflow
 *
 * Provides:
 * - listOwnerMismatches(): Returns all unresolved mismatch flags (moderator/admin)
 * - clearOwnerMismatch(): Clears the OWNER_MISMATCH block, unblocking payouts
 * - banOwnerMismatch(): Escalates to immediate BAN sanction + audit event
 * - persistMismatchFlag(): Creates a mismatch flag record when detection occurs
 */

import {
  MismatchReviewActionSchema,
  OwnerMismatchFlagSchema,
  SanctionActionSchema,
  type MismatchReviewAction,
  type OwnerMismatchFlag
} from '@claw/contracts';
import { nowIso, uid } from '@claw/utils';
import type { AuthContext, Store } from '../types/domain.js';
import { AuditLedger } from '../core/events.js';
import { assertDomain, DomainError } from '../core/errors.js';

export class ModerationService {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLedger
  ) {}

  /**
   * Persist a new owner mismatch flag when detection occurs.
   * Called from MoltbookIdentityService.verify() when an owner handle change is detected.
   * Idempotent: does not create a duplicate flag for the same agent+handle pair.
   */
  persistMismatchFlag(agentId: string, previousHandle: string, newHandle: string): OwnerMismatchFlag {
    // Check for existing unresolved flag for this agent with same handle pair
    for (const flag of this.store.ownerMismatchFlags.values()) {
      if (
        flag.agentId === agentId &&
        flag.previousHandle === previousHandle &&
        flag.newHandle === newHandle &&
        !flag.resolvedAt
      ) {
        return flag; // Already flagged, idempotent
      }
    }

    const flag = OwnerMismatchFlagSchema.parse({
      flagId: uid('mismatch'),
      agentId,
      previousHandle,
      newHandle,
      detectedAt: nowIso()
    });

    this.store.ownerMismatchFlags.set(flag.flagId, flag);

    this.audit.publish('moderation.owner_mismatch.detected', agentId, {
      flagId: flag.flagId,
      previousHandle,
      newHandle
    });

    return flag;
  }

  /**
   * List all unresolved owner mismatch flags, ordered by detectedAt (oldest first).
   * Only accessible to moderators and admins.
   */
  listOwnerMismatches(): OwnerMismatchFlag[] {
    return [...this.store.ownerMismatchFlags.values()]
      .filter((flag) => !flag.resolvedAt)
      .sort((a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime());
  }

  /**
   * Clear an owner mismatch flag for a specific agent.
   * Removes the OWNER_MISMATCH block reason from the snapshot, unblocking payouts.
   * Updates the historical owner handle to the new handle (accepting the transfer).
   */
  clearOwnerMismatch(actor: AuthContext, agentId: string, notes?: string): { cleared: boolean; flagId: string } {
    const flag = this.findUnresolvedFlag(agentId);

    // Resolve the flag
    const resolved: OwnerMismatchFlag = {
      ...flag,
      resolvedAt: nowIso(),
      resolution: 'cleared',
      resolvedBy: actor.actorAgentId
    };
    this.store.ownerMismatchFlags.set(flag.flagId, resolved);

    // Record the review action
    const action = MismatchReviewActionSchema.parse({
      actionId: uid('mra'),
      flagId: flag.flagId,
      moderatorId: actor.actorAgentId,
      actionType: 'cleared',
      notes,
      actedAt: nowIso()
    });
    this.store.mismatchReviewActions.set(action.actionId, action);

    // Update historical owner handle to accept the new handle
    this.store.historicalOwnerHandles.set(agentId, flag.newHandle);

    // Remove OWNER_MISMATCH from the agent's snapshot blockReasons
    this.removeOwnerMismatchFromSnapshot(agentId);

    this.audit.publish('moderation.owner_mismatch.cleared', agentId, {
      flagId: flag.flagId,
      moderatorId: actor.actorAgentId,
      previousHandle: flag.previousHandle,
      newHandle: flag.newHandle,
      notes
    });

    return { cleared: true, flagId: flag.flagId };
  }

  /**
   * Escalate an owner mismatch to BAN. Applies an immediate BAN sanction
   * and updates the agent's status to BANNED.
   * Only accessible to admins.
   */
  banOwnerMismatch(actor: AuthContext, agentId: string, notes?: string): { banned: boolean; flagId: string; sanctionId: string } {
    const flag = this.findUnresolvedFlag(agentId);

    // Resolve the flag
    const resolved: OwnerMismatchFlag = {
      ...flag,
      resolvedAt: nowIso(),
      resolution: 'banned',
      resolvedBy: actor.actorAgentId
    };
    this.store.ownerMismatchFlags.set(flag.flagId, resolved);

    // Record the review action
    const action = MismatchReviewActionSchema.parse({
      actionId: uid('mra'),
      flagId: flag.flagId,
      moderatorId: actor.actorAgentId,
      actionType: 'banned',
      notes,
      actedAt: nowIso()
    });
    this.store.mismatchReviewActions.set(action.actionId, action);

    // Apply immediate BAN sanction
    const sanction = SanctionActionSchema.parse({
      sanctionId: uid('sanction'),
      agentId,
      type: 'BAN',
      reasonCode: 'OWNER_MISMATCH_ESCALATION',
      status: 'ACTIVE',
      effectiveAt: nowIso()
    });

    const sanctions = this.store.sanctions.get(agentId) ?? [];
    sanctions.push(sanction);
    this.store.sanctions.set(agentId, sanctions);

    // Update agent status to BANNED
    const agent = this.store.agents.get(agentId);
    assertDomain(Boolean(agent), 'AGENT_NOT_FOUND', 'Agent not found.', 404);
    this.store.agents.set(agentId, {
      ...agent!,
      profile: { ...agent!.profile, status: 'BANNED' }
    });

    // TASK-ENFORCE-007: Track banned owner handles to prevent re-registration
    const snapshot = this.store.moltbookSnapshots.get(agentId);
    if (snapshot?.agent?.owner?.xHandle) {
      this.store.bannedOwnerHandles.add(snapshot.agent.owner.xHandle);
    }
    // Also add both old and new handles from the mismatch flag
    if (flag.previousHandle) {
      this.store.bannedOwnerHandles.add(flag.previousHandle);
    }
    if (flag.newHandle) {
      this.store.bannedOwnerHandles.add(flag.newHandle);
    }

    this.audit.publish('moderation.owner_mismatch.banned', agentId, {
      flagId: flag.flagId,
      moderatorId: actor.actorAgentId,
      sanctionId: sanction.sanctionId,
      previousHandle: flag.previousHandle,
      newHandle: flag.newHandle,
      notes
    });

    return { banned: true, flagId: flag.flagId, sanctionId: sanction.sanctionId };
  }

  /**
   * Check if an agent has an unresolved owner mismatch flag.
   */
  hasUnresolvedMismatch(agentId: string): boolean {
    for (const flag of this.store.ownerMismatchFlags.values()) {
      if (flag.agentId === agentId && !flag.resolvedAt) {
        return true;
      }
    }
    return false;
  }

  private findUnresolvedFlag(agentId: string): OwnerMismatchFlag {
    for (const flag of this.store.ownerMismatchFlags.values()) {
      if (flag.agentId === agentId && !flag.resolvedAt) {
        return flag;
      }
    }
    throw new DomainError('MISMATCH_NOT_FOUND', `No unresolved owner mismatch flag found for agent ${agentId}.`, 404);
  }

  /**
   * Remove OWNER_MISMATCH from the agent's Moltbook verification snapshot blockReasons.
   * This effectively unblocks payouts.
   */
  private removeOwnerMismatchFromSnapshot(agentId: string): void {
    const snapshot = this.store.moltbookSnapshots.get(agentId);
    if (!snapshot) return;

    const updatedReasons = snapshot.blockReasons.filter((reason) => reason.code !== 'OWNER_MISMATCH');
    const updatedSnapshot = {
      ...snapshot,
      blockReasons: updatedReasons
    };
    this.store.moltbookSnapshots.set(agentId, updatedSnapshot);
  }
}
