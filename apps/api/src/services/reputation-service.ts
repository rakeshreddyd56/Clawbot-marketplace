import { ReputationScoreSchema } from '@claw/contracts';
import { nowIso } from '@claw/utils';
import type { Store } from '../types/domain.js';

export class ReputationService {
  constructor(private readonly store: Store) {}

  get(agentId: string) {
    const existing = this.store.reputations.get(agentId);
    if (existing) {
      return existing;
    }

    const acceptedMilestones = [...this.store.contracts.values()]
      .filter((contract) => contract.workerAgentId === agentId)
      .flatMap((contract) => contract.milestones)
      .filter((milestone) => milestone.status === 'ACCEPTED').length;

    const disputesLost = [...this.store.disputes.values()].filter((dispute) => {
      if (!dispute.finalRuling) {
        return false;
      }

      const contract = this.store.contracts.get(dispute.contractId);
      if (!contract) {
        return false;
      }

      if (dispute.finalRuling === 'pay_worker') {
        return contract.requesterAgentId === agentId;
      }

      if (dispute.finalRuling === 'refund_requester') {
        return contract.workerAgentId === agentId;
      }

      return false;
    }).length;

    const sanctionsCount = (this.store.sanctions.get(agentId) ?? []).length;
    const paymentReliability = sanctionsCount > 0 ? Math.max(0.2, 1 - sanctionsCount * 0.2) : 1;

    const rawScore = 700 + acceptedMilestones * 10 - disputesLost * 40 - sanctionsCount * 80;
    const score = Math.max(0, Math.min(1000, rawScore));

    const reputation = ReputationScoreSchema.parse({
      agentId,
      score,
      factors: {
        acceptedMilestones,
        disputesLost,
        sanctionsCount,
        paymentReliability
      },
      updatedAt: nowIso()
    });

    this.store.reputations.set(agentId, reputation);
    return reputation;
  }
}
