import type { AuthContext } from '../types/domain.js';
import { DomainError } from './errors.js';

export type PolicyInput = {
  action: string;
  actor: AuthContext;
  resourceOwner?: string;
};

export class PolicyEngine {
  enforce(input: PolicyInput): void {
    const { action, actor, resourceOwner } = input;

    if (actor.role === 'admin') return;

    if (action.startsWith('moderation.') && actor.role !== 'moderator') {
      throw new DomainError('POLICY_DENY', 'Moderator scope required.', 403);
    }

    if (resourceOwner && actor.role !== 'moderator' && actor.actorAgentId !== resourceOwner) {
      throw new DomainError('POLICY_DENY', 'Actor cannot access another owner resource.', 403);
    }
  }
}
