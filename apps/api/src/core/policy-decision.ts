import { PolicyDecisionSchema, type PolicyDecision } from '@claw/contracts';
import { nowIso, sha256, uid } from '@claw/utils';
import type { AuthContext, Store } from '../types/domain.js';
import { DomainError } from './errors.js';

export type PolicyEvalInput = {
  action: string;
  actor: AuthContext;
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
