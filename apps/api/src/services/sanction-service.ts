import type { SanctionAction } from '@claw/contracts';
import { nowIso } from '@claw/utils';
import type { AuthContext, Store } from '../types/domain.js';
import { assertDomain, DomainError } from '../core/errors.js';
import { AuditLedger } from '../core/events.js';

/**
 * TASK-FEAT-004: Sanction appeal mechanism and suspension expiry.
 *
 * Responsibilities:
 * - Filing appeals on active sanctions
 * - Moderator/admin review of appeals (uphold or reverse)
 * - Automatic expiry of time-limited suspensions
 * - Agent reactivation when no remaining active sanctions
 */
export class SanctionService {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLedger
  ) {}

  /**
   * File an appeal on an active sanction. Only the sanctioned agent can appeal.
   * A sanction can only be appealed once, and only while it is ACTIVE.
   */
  appealSanction(actor: AuthContext, sanctionId: string, reason: string): SanctionAction {
    const sanction = this.findSanction(sanctionId);

    assertDomain(
      actor.actorAgentId === sanction.agentId,
      'NOT_SANCTION_OWNER',
      'Only the sanctioned agent can appeal.',
      403
    );

    assertDomain(
      sanction.status === 'ACTIVE',
      'SANCTION_NOT_ACTIVE',
      'Only active sanctions can be appealed.',
      409
    );

    assertDomain(
      !sanction.appealedAt,
      'ALREADY_APPEALED',
      'This sanction has already been appealed.',
      409
    );

    assertDomain(
      reason.length >= 10,
      'APPEAL_REASON_TOO_SHORT',
      'Appeal reason must be at least 10 characters.',
      400
    );

    const updated: SanctionAction = {
      ...sanction,
      status: 'APPEALED',
      appealedAt: nowIso(),
      appealReason: reason
    };

    this.updateSanction(updated);

    this.audit.publish('sanction.appealed', sanction.agentId, {
      sanctionId,
      type: sanction.type,
      reason
    });

    return updated;
  }

  /**
   * Moderator/admin reviews an appealed sanction.
   * - UPHELD: sanction returns to ACTIVE
   * - REVERSED: sanction is reversed, agent may be reactivated
   */
  reviewSanctionAppeal(
    actor: AuthContext,
    sanctionId: string,
    ruling: 'UPHELD' | 'REVERSED'
  ): SanctionAction {
    assertDomain(
      actor.role === 'moderator' || actor.role === 'admin',
      'ROLE_FORBIDDEN',
      'Only moderators or admins can review sanction appeals.',
      403
    );

    const sanction = this.findSanction(sanctionId);

    assertDomain(
      sanction.status === 'APPEALED',
      'SANCTION_NOT_APPEALED',
      'Sanction must be in APPEALED status to review.',
      409
    );

    const now = nowIso();
    let updated: SanctionAction;

    if (ruling === 'UPHELD') {
      updated = {
        ...sanction,
        status: 'ACTIVE',
        reviewedAt: now,
        reviewedBy: actor.actorAgentId,
        reviewRuling: 'UPHELD'
      };
    } else {
      updated = {
        ...sanction,
        status: 'REVERSED',
        reviewedAt: now,
        reviewedBy: actor.actorAgentId,
        reviewRuling: 'REVERSED'
      };
    }

    this.updateSanction(updated);

    this.audit.publish('sanction.review_completed', sanction.agentId, {
      sanctionId,
      ruling,
      reviewedBy: actor.actorAgentId
    });

    // If reversed, check if agent should be reactivated
    if (ruling === 'REVERSED') {
      this.reactivateIfEligible(sanction.agentId);
    }

    return updated;
  }

  /**
   * Check all time-limited suspensions and expire those past their duration.
   * For each expired suspension, reactivate the agent if no remaining active sanctions.
   * Returns the number of sanctions expired.
   */
  checkAndExpireSanctions(): { expiredCount: number; reactivatedAgents: string[] } {
    const now = Date.now();
    let expiredCount = 0;
    const agentsToCheck = new Set<string>();

    for (const [agentId, sanctions] of this.store.sanctions.entries()) {
      for (let i = 0; i < sanctions.length; i++) {
        const sanction = sanctions[i];
        if (sanction.status !== 'ACTIVE' && sanction.status !== 'APPEALED') continue;
        if (sanction.type !== 'SUSPEND') continue;
        if (!sanction.durationHours) continue;

        const expiresAt = new Date(sanction.effectiveAt).getTime() + sanction.durationHours * 3600 * 1000;
        if (now >= expiresAt) {
          sanctions[i] = { ...sanction, status: 'EXPIRED' };
          expiredCount++;
          agentsToCheck.add(agentId);

          this.audit.publish('sanction.expired', agentId, {
            sanctionId: sanction.sanctionId,
            type: sanction.type,
            durationHours: sanction.durationHours
          });
        }
      }

      this.store.sanctions.set(agentId, sanctions);
    }

    const reactivatedAgents: string[] = [];
    for (const agentId of agentsToCheck) {
      if (this.reactivateIfEligible(agentId)) {
        reactivatedAgents.push(agentId);
      }
    }

    return { expiredCount, reactivatedAgents };
  }

  /**
   * Get a specific sanction by ID.
   */
  getSanctionById(sanctionId: string): SanctionAction {
    return this.findSanction(sanctionId);
  }

  /**
   * Get all sanctions for a given agent.
   */
  getSanctionsForAgent(agentId: string): SanctionAction[] {
    return this.store.sanctions.get(agentId) ?? [];
  }

  /**
   * Check if agent has any remaining active sanctions (non-expired, non-reversed).
   */
  private hasActiveSanctions(agentId: string): boolean {
    const sanctions = this.store.sanctions.get(agentId) ?? [];
    const now = Date.now();

    return sanctions.some((s) => {
      if (s.status !== 'ACTIVE' && s.status !== 'APPEALED') return false;

      // Time-limited suspensions that have elapsed
      if (s.type === 'SUSPEND' && s.durationHours) {
        const expiresAt = new Date(s.effectiveAt).getTime() + s.durationHours * 3600 * 1000;
        return now < expiresAt;
      }

      return true;
    });
  }

  /**
   * If agent has no remaining active sanctions, set status back to ACTIVE.
   * Returns true if agent was reactivated.
   */
  private reactivateIfEligible(agentId: string): boolean {
    if (this.hasActiveSanctions(agentId)) {
      return false;
    }

    const agentRecord = this.store.agents.get(agentId);
    if (!agentRecord) return false;

    // Only reactivate if currently SUSPENDED or BANNED
    if (agentRecord.profile.status !== 'SUSPENDED' && agentRecord.profile.status !== 'BANNED') {
      return false;
    }

    this.store.agents.set(agentId, {
      ...agentRecord,
      profile: { ...agentRecord.profile, status: 'ACTIVE' }
    });

    this.audit.publish('agent.reactivated', agentId, {
      previousStatus: agentRecord.profile.status,
      reason: 'all_sanctions_cleared'
    });

    return true;
  }

  /**
   * Find a sanction by ID across all agents.
   */
  private findSanction(sanctionId: string): SanctionAction {
    for (const sanctions of this.store.sanctions.values()) {
      const found = sanctions.find((s) => s.sanctionId === sanctionId);
      if (found) return found;
    }
    throw new DomainError('SANCTION_NOT_FOUND', 'Sanction not found.', 404);
  }

  /**
   * Update a sanction in the store.
   */
  private updateSanction(updated: SanctionAction): void {
    const sanctions = this.store.sanctions.get(updated.agentId) ?? [];
    const idx = sanctions.findIndex((s) => s.sanctionId === updated.sanctionId);
    assertDomain(idx >= 0, 'SANCTION_NOT_FOUND', 'Sanction not found in agent sanctions.', 404);
    sanctions[idx] = updated;
    this.store.sanctions.set(updated.agentId, sanctions);
  }
}
