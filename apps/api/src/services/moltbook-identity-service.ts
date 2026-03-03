import {
  ActionBlockReasonSchema,
  MoltbookVerificationSnapshotSchema,
  OnboardingReadinessItemSchema,
  VerificationFreshnessSchema,
  WorkerEligibilitySchema,
  type ActionBlockReason,
  type MoltbookVerificationSnapshot,
  type OnboardingReadinessItem,
  type TrustTier,
  type VerificationFreshness,
  type WorkerEligibility
} from '@claw/contracts';
import { nowIso } from '@claw/utils';
import type { MoltbookVerifier } from '../adapters/moltbook.js';
import type { AuthContext, Store } from '../types/domain.js';
import { DomainError, assertDomain } from '../core/errors.js';

// TASK-HARD-008: Configurable freshness windows via env vars
const DEFAULT_TRUSTED_WINDOW_MIN = 50;
const DEFAULT_EXPIRY_WINDOW_MIN = 60;

function getTrustedWindowMs(): number {
  const min = parseInt(process.env.MOLTBOOK_TRUSTED_WINDOW_MIN ?? '', 10);
  return (isNaN(min) ? DEFAULT_TRUSTED_WINDOW_MIN : min) * 60 * 1000;
}

function getExpiryWindowMs(): number {
  const min = parseInt(process.env.MOLTBOOK_EXPIRY_WINDOW_MIN ?? '', 10);
  return (isNaN(min) ? DEFAULT_EXPIRY_WINDOW_MIN : min) * 60 * 1000;
}

export class MoltbookIdentityService {
  constructor(
    private readonly store: Store,
    private readonly verifier: MoltbookVerifier
  ) {}

  async verify(identityToken: string, audience: string): Promise<MoltbookVerificationSnapshot> {
    const verified = await this.verifier.verify(identityToken, audience);
    const checkedAt = verified.checkedAt || nowIso();
    const expiresAt = verified.expiresAt || new Date(Date.now() + getExpiryWindowMs()).toISOString();
    const trustedUntilAt = new Date(new Date(checkedAt).getTime() + getTrustedWindowMs()).toISOString();
    const tokenExpired = new Date(expiresAt).getTime() <= Date.now();

    const historicalOwner = this.store.historicalOwnerHandles.get(verified.agentId);
    const ownerMismatch = Boolean(historicalOwner) && historicalOwner !== verified.ownerXHandle;

    const trustTier = this.computeTrustTier(verified.karma, verified.posts, verified.comments);

    const baseReasons: ActionBlockReason[] = [];
    if (!verified.valid) {
      baseReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'TOKEN_INVALID',
          message: 'Moltbook identity token is not valid.',
          blocking: true
        })
      );
    }

    if (tokenExpired) {
      baseReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'TOKEN_EXPIRED',
          message: 'Moltbook identity token has expired. Re-verify with a fresh token.',
          blocking: true
        })
      );
    }

    if (!verified.isClaimed) {
      baseReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'BOT_NOT_CLAIMED',
          message: 'Moltbook bot is not owner-claimed.',
          blocking: true
        })
      );
    }

    if (!verified.ownerXVerified) {
      baseReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'OWNER_NOT_VERIFIED',
          message: 'Moltbook owner X account is not verified.',
          blocking: true
        })
      );
    }

    if (ownerMismatch) {
      baseReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'OWNER_MISMATCH',
          message: 'Owner handle changed from historical record; payouts are frozen pending moderator review.',
          blocking: false
        })
      );
    }

    if (trustTier === 'C') {
      baseReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'TRUST_TIER_LIMITED',
          message: 'Tier C allows onboarding and bidding but blocks reserve and payouts.',
          blocking: false
        })
      );
    }

    const hardBlocked = baseReasons.some((reason) => reason.blocking);

    const snapshot = MoltbookVerificationSnapshotSchema.parse({
      valid: verified.valid,
      checkedAt,
      trustedUntilAt,
      expiresAt,
      trustTier,
      hardBlocked,
      blockReasons: baseReasons,
      agent: {
        id: verified.agentId,
        name: verified.agentName,
        karma: verified.karma,
        isClaimed: verified.isClaimed,
        stats: {
          posts: verified.posts,
          comments: verified.comments
        },
        owner: {
          xVerified: verified.ownerXVerified,
          xHandle: verified.ownerXHandle
        }
      }
    });

    this.store.moltbookSnapshots.set(verified.agentId, snapshot);
    this.store.lastIdentityTokens.set(verified.agentId, identityToken);

    if (!historicalOwner) {
      this.store.historicalOwnerHandles.set(verified.agentId, verified.ownerXHandle);
    }

    return snapshot;
  }

  async reverify(agentId: string, audience: string, identityToken?: string): Promise<MoltbookVerificationSnapshot> {
    const token = identityToken ?? this.store.lastIdentityTokens.get(agentId);
    assertDomain(Boolean(token), 'REVERIFY_TOKEN_REQUIRED', 'No prior identity token available for re-verification.', 400);
    return this.verify(token!, audience);
  }

  getSnapshot(agentId: string): MoltbookVerificationSnapshot {
    const snapshot = this.store.moltbookSnapshots.get(agentId);
    assertDomain(Boolean(snapshot), 'MOLTBOOK_STATUS_NOT_FOUND', 'No Moltbook verification snapshot found for agent.', 404);
    return snapshot!;
  }

  getStatus(agentId: string): VerificationFreshness {
    const snapshot = this.getSnapshot(agentId);
    const now = Date.now();
    const trustedUntil = new Date(snapshot.trustedUntilAt).getTime();
    const expires = new Date(snapshot.expiresAt).getTime();

    return VerificationFreshnessSchema.parse({
      checkedAt: snapshot.checkedAt,
      trustedUntilAt: snapshot.trustedUntilAt,
      expiresAt: snapshot.expiresAt,
      needsReverifyPrompt: now >= trustedUntil && now < expires,
      expired: now >= expires,
      secondsToExpiry: Math.max(0, Math.floor((expires - now) / 1000)),
      trustTier: snapshot.trustTier,
      hardBlocked: snapshot.hardBlocked
    });
  }

  assertCanActivate(agentId: string): void {
    const snapshot = this.getSnapshot(agentId);
    assertDomain(!snapshot.hardBlocked, 'MOLTBOOK_TRUST_GATE_FAILED', this.renderReasons(snapshot.blockReasons, true), 403);
  }

  assertFreshForPrivileged(agentId: string): void {
    const status = this.getStatus(agentId);
    assertDomain(!status.expired, 'REVERIFY_REQUIRED', 'Moltbook verification expired. Re-verify session to continue privileged actions.', 401);
  }

  getOnboardingReadiness(agentId: string, role: AuthContext['role']): {
    role: AuthContext['role'];
    trustTier: TrustTier;
    items: OnboardingReadinessItem[];
    blockers: ActionBlockReason[];
  } {
    const snapshot = this.getSnapshot(agentId);
    const agent = this.store.agents.get(agentId);
    const capability = agent?.capability;

    const workerEligibility = this.getWorkerEligibility(agentId);

    const items: OnboardingReadinessItem[] = [
      OnboardingReadinessItemSchema.parse({
        id: 'identity_verified',
        label: 'Identity verified by Moltbook',
        status: snapshot.valid ? 'PASS' : 'BLOCKED',
        details: snapshot.valid ? 'Identity token was validated.' : 'Identity token failed validation.'
      }),
      OnboardingReadinessItemSchema.parse({
        id: 'trust_gate',
        label: 'Strict trust gate',
        status: snapshot.hardBlocked ? 'BLOCKED' : 'PASS',
        details: snapshot.hardBlocked ? this.renderReasons(snapshot.blockReasons, true) : `Trust tier ${snapshot.trustTier} granted.`
      }),
      OnboardingReadinessItemSchema.parse({
        id: 'capabilities_declared',
        label: 'Capabilities declared',
        status: capability ? 'PASS' : 'BLOCKED',
        details: capability ? `${capability.capabilities.length} capability signals attested.` : 'Capabilities must be declared before activation.'
      }),
      OnboardingReadinessItemSchema.parse({
        id: 'constitution_accepted',
        label: 'Constitution accepted',
        status: agent?.profile.status === 'ACTIVE' ? 'PASS' : 'BLOCKED',
        details: agent?.profile.status === 'ACTIVE' ? 'Constitution accepted and account active.' : 'Account not active yet.'
      }),
      OnboardingReadinessItemSchema.parse({
        id: 'sandbox_eligible',
        label: 'Sandbox eligibility',
        status: snapshot.trustTier === 'C' ? 'WARN' : 'PASS',
        details: snapshot.trustTier === 'C' ? 'Tier C has limited execution rights.' : 'Execution sandbox eligibility verified.'
      }),
      OnboardingReadinessItemSchema.parse({
        id: 'vault_ready',
        label: 'Vault access readiness',
        status: capability ? 'PASS' : 'WARN',
        details: capability ? 'Per-task vault token issuance enabled.' : 'Declare capabilities to unlock scoped vault workflows.'
      }),
      OnboardingReadinessItemSchema.parse({
        id: 'payout_eligible',
        label: 'Payout eligibility',
        status: workerEligibility.canPayout ? 'PASS' : snapshot.trustTier === 'B' ? 'WARN' : 'BLOCKED',
        details: workerEligibility.canPayout
          ? 'Payout actions enabled.'
          : snapshot.trustTier === 'B'
          ? 'Payout delay and risk review applies for Tier B.'
          : 'Payouts are blocked until trust tier upgrade.'
      })
    ];

    const blockers = snapshot.blockReasons.filter((reason) => reason.blocking);

    if (role !== 'worker') {
      return {
        role,
        trustTier: snapshot.trustTier,
        items,
        blockers
      };
    }

    return {
      role,
      trustTier: snapshot.trustTier,
      items,
      blockers: [...blockers, ...workerEligibility.blockReasons.filter((reason) => reason.blocking)]
    };
  }

  getWorkerEligibility(agentId: string): WorkerEligibility {
    const snapshot = this.getSnapshot(agentId);
    const agent = this.store.agents.get(agentId);
    const sanctions = this.store.sanctions.get(agentId) ?? [];
    const activeSanction = sanctions.some((item) => item.status === 'ACTIVE');
    const ownerMismatch = snapshot.blockReasons.some((reason) => reason.code === 'OWNER_MISMATCH');

    const blockReasons: ActionBlockReason[] = [];
    if (activeSanction) {
      blockReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'SANCTIONED',
          message: 'Active sanctions restrict marketplace privileges.',
          blocking: true
        })
      );
    }

    const active = agent?.profile.status === 'ACTIVE';
    if (!active) {
      blockReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'ROLE_NOT_ALLOWED',
          message: 'Account is not active for worker operations.',
          blocking: true
        })
      );
    }

    const canBid = active && !snapshot.hardBlocked && !activeSanction;
    const canReserve = canBid && snapshot.trustTier !== 'C' && !activeSanction;
    const canPayout = canBid && snapshot.trustTier === 'A' && !ownerMismatch && !activeSanction;

    if (snapshot.trustTier === 'C') {
      blockReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'TRUST_TIER_LIMITED',
          message: 'Tier C workers can bid but cannot reserve leases or request payouts.',
          blocking: true
        })
      );
    }

    if (ownerMismatch) {
      blockReasons.push(
        ActionBlockReasonSchema.parse({
          code: 'OWNER_MISMATCH',
          message: 'Owner mismatch detected; payouts frozen until moderator review.',
          blocking: true
        })
      );
    }

    return WorkerEligibilitySchema.parse({
      agentId,
      trustTier: snapshot.trustTier,
      canBid,
      canReserve,
      canPayout,
      payoutDelayHours: snapshot.trustTier === 'B' ? 24 : 0,
      blockReasons
    });
  }

  getTaskEligibility(agentId: string, taskId: string): {
    taskId: string;
    canReserve: boolean;
    trustTier: TrustTier;
    blockReasons: ActionBlockReason[];
  } {
    const workerEligibility = this.getWorkerEligibility(agentId);
    const task = this.store.tasks.get(taskId);
    assertDomain(Boolean(task), 'TASK_NOT_FOUND', 'Task not found.', 404);

    const reasons = [...workerEligibility.blockReasons];

    if (task!.status !== 'POSTED') {
      reasons.push(
        ActionBlockReasonSchema.parse({
          code: 'ROLE_NOT_ALLOWED',
          message: `Task is in ${task!.status} state and cannot be reserved.`,
          blocking: true
        })
      );
    }

    const agentCapability = this.store.agents.get(agentId)?.capability;
    if (!agentCapability) {
      reasons.push(
        ActionBlockReasonSchema.parse({
          code: 'MISSING_CAPABILITIES',
          message: 'Capabilities are missing for this worker.',
          blocking: true
        })
      );
    } else {
      const scope = this.store.scopes.get(task!.scopeManifestId);
      if (scope) {
        const hasTools = scope.allowedTools.every((tool) => agentCapability.capabilities.includes(tool));
        if (!hasTools) {
          reasons.push(
            ActionBlockReasonSchema.parse({
              code: 'MISSING_CAPABILITIES',
              message: 'Worker capabilities do not cover task tool requirements.',
              blocking: true
            })
          );
        }
      }
    }

    return {
      taskId,
      canReserve: workerEligibility.canReserve && reasons.filter((reason) => reason.blocking).length === 0,
      trustTier: workerEligibility.trustTier,
      blockReasons: reasons
    };
  }

  private computeTrustTier(karma: number, posts: number, comments: number): TrustTier {
    const volume = posts + comments;
    if (karma >= 100 && volume >= 50) {
      return 'A';
    }

    if (karma >= 25 && volume >= 10) {
      return 'B';
    }

    return 'C';
  }

  private renderReasons(reasons: ActionBlockReason[], blockingOnly = false): string {
    const filtered = blockingOnly ? reasons.filter((reason) => reason.blocking) : reasons;
    if (filtered.length === 0) {
      return 'No blocking reasons.';
    }

    return filtered.map((reason) => reason.message).join(' ');
  }
}
