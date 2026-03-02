import { ExecutionSessionSchema, type ContractTerms } from '@claw/contracts';
import { nowIso, uid } from '@claw/utils';
import type { AuthContext, Store } from '../types/domain.js';
import { assertDomain } from '../core/errors.js';

export class ExecutionService {
  constructor(private readonly store: Store) {}

  startMilestone(actor: AuthContext, contract: ContractTerms, milestoneId: string): { executionId: string } {
    assertDomain(actor.actorAgentId === contract.workerAgentId || actor.role === 'admin', 'MILESTONE_FORBIDDEN', 'Only assigned worker can start milestone.', 403);

    const milestone = contract.milestones.find((item) => item.milestoneId === milestoneId);
    assertDomain(Boolean(milestone), 'MILESTONE_NOT_FOUND', 'Milestone not found.', 404);

    if (milestone!.status === 'IN_PROGRESS') {
      const existing = [...this.store.executions.values()].find((session) => session.contractId === contract.contractId && session.milestoneId === milestoneId && session.state === 'RUNNING');
      if (existing) {
        return { executionId: existing.executionId };
      }
    }

    assertDomain(milestone!.status === 'PENDING' || milestone!.status === 'IN_PROGRESS', 'MILESTONE_INVALID_STATE', 'Milestone cannot be started from current state.', 409);

    const updatedMilestones = contract.milestones.map((item) => item.milestoneId === milestoneId ? { ...item, status: 'IN_PROGRESS' as const } : item);
    this.store.contracts.set(contract.contractId, { ...contract, milestones: updatedMilestones });

    const execution = ExecutionSessionSchema.parse({
      executionId: uid('exec'),
      contractId: contract.contractId,
      milestoneId,
      sandboxId: uid('sandbox'),
      policyVersion: 'opa.bundle.v1',
      state: 'RUNNING',
      startedAt: nowIso(),
      lastHeartbeatAt: nowIso()
    });

    this.store.executions.set(execution.executionId, execution);
    return { executionId: execution.executionId };
  }

  closeExecution(contractId: string, milestoneId: string): void {
    const session = [...this.store.executions.values()]
      .filter((item) => item.contractId === contractId && item.milestoneId === milestoneId && item.state === 'RUNNING')
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];

    if (!session) {
      return;
    }

    this.store.executions.set(session.executionId, {
      ...session,
      state: 'COMPLETED',
      endedAt: nowIso(),
      lastHeartbeatAt: nowIso()
    });
  }

  heartbeat(executionId: string): { lastHeartbeatAt: string } {
    const execution = this.store.executions.get(executionId);
    assertDomain(Boolean(execution), 'EXECUTION_NOT_FOUND', 'Execution session not found.', 404);

    const next = {
      ...execution!,
      lastHeartbeatAt: nowIso()
    };

    this.store.executions.set(executionId, next);
    return {
      lastHeartbeatAt: next.lastHeartbeatAt
    };
  }
}
