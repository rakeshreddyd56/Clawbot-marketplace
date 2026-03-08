import { PolicyDecisionSchema, type PolicyDecision } from '@claw/contracts';
import { nowIso, sha256, uid } from '@claw/utils';
import type { AuthContext, Store } from '../types/domain.js';
import { DomainError } from './errors.js';

// GAP-CRIT-002: Shared freshness window constant — MUST match OPA marketplace.rego identity_fresh rule.
// OPA uses: identity_verified_at > (time.now_ns() / 1e9) - 3600
// Configurable via MOLTBOOK_EXPIRY_WINDOW_MIN env var (default: 60 minutes).
export const IDENTITY_FRESHNESS_WINDOW_SEC = (() => {
  const min = parseInt(process.env.MOLTBOOK_EXPIRY_WINDOW_MIN ?? '', 10);
  return (isNaN(min) ? 60 : min) * 60;
})();

export type PolicyEvalInput = {
  action: string;
  actor: AuthContext;
  /** Unix timestamp (seconds) of last identity verification. Required for privileged action checks. */
  identityVerifiedAt?: number;
  /** Agent trust tier. Required for tier C restriction checks. */
  trustTier?: 'A' | 'B' | 'C';
  context?: Record<string, unknown>;
};

const KNOWN_ACTIONS = new Set([
  'agent.profile.read',
  'task.create',
  'task.post',
  'task.list',
  'task.reserve',
  'task.heartbeat',
  'task.cancel',
  'task.accept',
  'task.eligibility.read',
  'task.scope.read',
  'bid.create',
  'contract.read',
  'contract.milestone.start',
  'contract.milestone.deliver',
  'contract.milestone.accept',
  'artifact.upload_url.create',
  'artifact.finalize',
  'artifact.signature.preview',
  'dispute.open',
  'dispute.read',
  'dispute.evidence.read',
  'dispute.appeal',
  'dispute.resolve',
  'vault.token.create',
  'wallet.topup',
  'wallet.payout',
  'wallet.ledger.read',
  'sanctions.read',
  'reputation.read',
  'payments.webhook',
  'audit.read'
]);

// GAP-CRIT-002: Privileged actions that require fresh identity (must match OPA privileged_actions)
const PRIVILEGED_ACTIONS = new Set([
  'wallet.payout',
  'wallet.escrow.lock',
  'wallet.escrow.release',
  'wallet.escrow.slash',
  'vault.token.issue',
  'vault.token.create',
  'sanction.apply',
  'sanction.lift',
  'identity.trust_tier.update',
]);

// GAP-CRIT-002: Trust Tier C blocked actions (must match OPA tier_c_blocked_actions)
const TIER_C_BLOCKED_ACTIONS = new Set([
  'task.reserve',
  'wallet.payout',
  'wallet.escrow.lock',
  'wallet.escrow.release',
  'wallet.escrow.slash',
  'vault.token.issue',
  'vault.token.create',
]);

const CONTEXT_ALLOWLIST: Record<string, string[]> = {
  'task.accept': ['taskId', 'leaseId'],
  'task.eligibility.read': ['taskId'],
  'task.scope.read': ['taskId', 'leaseId'],
  'contract.milestone.deliver': ['contractId', 'milestoneId'],
  'contract.milestone.accept': ['contractId', 'milestoneId'],
  'artifact.signature.preview': ['contractId', 'milestoneId'],
  'dispute.read': ['disputeId'],
  'dispute.evidence.read': ['disputeId'],
  'dispute.resolve': ['disputeId'],
  'vault.token.create': ['taskId', 'leaseId', 'dataRef'],
  'reputation.read': ['agentId'],
  'payments.webhook': ['eventType']
};

export class PolicyDecisionService {
  private readonly policyVersion = 'opa.bundle.v1';

  constructor(private readonly store: Store) {}

  decide(input: PolicyEvalInput): PolicyDecision {
    if (!KNOWN_ACTIONS.has(input.action)) {
      return this.record(input, false, 'UNKNOWN_ACTION');
    }

    const allowlist = CONTEXT_ALLOWLIST[input.action] ?? [];
    const contextKeys = Object.keys(input.context ?? {});
    const hasUnknownFields = contextKeys.some((key) => !allowlist.includes(key));
    if (hasUnknownFields) {
      return this.record(input, false, 'UNKNOWN_CONTEXT_FIELD');
    }

    // GAP-CRIT-002: Trust Tier C restriction (matches OPA tier_c_blocked)
    if (input.trustTier === 'C' && TIER_C_BLOCKED_ACTIONS.has(input.action)) {
      return this.record(input, false, 'TIER_C_RESTRICTED');
    }

    // GAP-CRIT-002: Identity freshness check for privileged actions (matches OPA identity_fresh)
    // Uses the same 60-minute window as OPA's marketplace.rego
    if (PRIVILEGED_ACTIONS.has(input.action)) {
      if (input.identityVerifiedAt == null) {
        return this.record(input, false, 'IDENTITY_NOT_FRESH');
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (input.identityVerifiedAt <= nowSec - IDENTITY_FRESHNESS_WINDOW_SEC) {
        return this.record(input, false, 'IDENTITY_NOT_FRESH');
      }
    }

    const allow = this.allowByRole(input.action, input.actor.role);
    return this.record(input, allow, allow ? 'ALLOW' : 'ROLE_DENY');
  }

  enforce(input: PolicyEvalInput): void {
    const decision = this.decide(input);
    if (!decision.allow) {
      throw new DomainError('POLICY_DENY', `Policy denied action ${input.action}: ${decision.reason}`, 403);
    }
  }

  private allowByRole(action: string, role: AuthContext['role']): boolean {
    if (role === 'admin') {
      return true;
    }

    if (role === 'moderator') {
      return !['wallet.topup', 'wallet.payout', 'task.create', 'task.reserve'].includes(action);
    }

    if (role === 'requester') {
      return [
        'agent.profile.read',
        'task.create',
        'task.post',
        'task.list',
        'task.cancel',
        'task.accept',
        'task.scope.read',
        'contract.read',
        'contract.milestone.accept',
        'dispute.open',
        'dispute.read',
        'dispute.evidence.read',
        'dispute.appeal',
        'wallet.topup',
        'wallet.payout',
        'wallet.ledger.read',
        'reputation.read',
        'audit.read',
        'sanctions.read'
      ].includes(action);
    }

    // worker role
    return [
      'agent.profile.read',
      'task.list',
      'task.reserve',
      'task.heartbeat',
      'task.eligibility.read',
      'task.scope.read',
      'bid.create',
      'contract.read',
      'contract.milestone.start',
      'contract.milestone.deliver',
      'artifact.upload_url.create',
      'artifact.finalize',
      'artifact.signature.preview',
      'dispute.open',
      'dispute.read',
      'dispute.evidence.read',
      'dispute.appeal',
      'vault.token.create',
      'wallet.payout',
      'wallet.ledger.read',
      'reputation.read',
      'audit.read',
      'sanctions.read'
    ].includes(action);
  }

  private record(input: PolicyEvalInput, allow: boolean, reason: string): PolicyDecision {
    // Extract the first context value that looks like an entity ID for filtering
    const contextValues = Object.values(input.context ?? {});
    const entityId = contextValues.length > 0 ? String(contextValues[0]) : undefined;

    const decision = PolicyDecisionSchema.parse({
      decisionId: uid('policy_decision'),
      policyVersion: this.policyVersion,
      action: input.action,
      actorAgentId: input.actor.actorAgentId,
      entityId,
      allow,
      reason,
      contextHash: sha256(JSON.stringify({ actor: input.actor, context: input.context ?? {} })),
      createdAt: nowIso()
    });

    this.store.policyDecisions.push(decision);
    return decision;
  }
}
