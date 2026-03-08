export type WorkflowState =
  | 'TASK_POSTED'
  | 'TASK_RESERVED'
  | 'TASK_ASSIGNED'
  | 'TASK_CLOSED'
  | 'MILESTONE_RUNNING'
  | 'MILESTONE_DELIVERED'
  | 'MILESTONE_ACCEPTED'
  | 'DISPUTE_OPEN'
  | 'DISPUTE_AUTO_DECIDED'
  | 'DISPUTE_APPEAL'
  | 'DISPUTE_FINAL';

export type TaskLifecycleCommand =
  | { type: 'reserve' }
  | { type: 'lease_expired' }
  | { type: 'accept' }
  | { type: 'cancel' };

export function taskLifecycleTransition(state: WorkflowState, command: TaskLifecycleCommand): WorkflowState {
  if (state === 'TASK_POSTED' && command.type === 'reserve') return 'TASK_RESERVED';
  if (state === 'TASK_RESERVED' && command.type === 'accept') return 'TASK_ASSIGNED';
  if (state === 'TASK_RESERVED' && command.type === 'lease_expired') return 'TASK_POSTED';
  if (command.type === 'cancel') return 'TASK_CLOSED';
  return state;
}

export type ContractExecutionCommand =
  | { type: 'start_milestone' }
  | { type: 'deliver' }
  | { type: 'accept' }
  | { type: 'timeout' }
  | { type: 'dispute' };

export function contractExecutionTransition(state: WorkflowState, command: ContractExecutionCommand): WorkflowState {
  if (state === 'TASK_ASSIGNED' && command.type === 'start_milestone') return 'MILESTONE_RUNNING';
  if (state === 'MILESTONE_RUNNING' && command.type === 'deliver') return 'MILESTONE_DELIVERED';
  if (state === 'MILESTONE_DELIVERED' && command.type === 'accept') return 'MILESTONE_ACCEPTED';
  if (state === 'MILESTONE_RUNNING' && command.type === 'timeout') return 'DISPUTE_OPEN';
  if (command.type === 'dispute') return 'DISPUTE_OPEN';
  return state;
}

export type DisputeResolutionCommand =
  | { type: 'auto_decide' }
  | { type: 'appeal' }
  | { type: 'finalize' };

export function disputeResolutionTransition(state: WorkflowState, command: DisputeResolutionCommand): WorkflowState {
  if (state === 'DISPUTE_OPEN' && command.type === 'auto_decide') return 'DISPUTE_AUTO_DECIDED';
  if ((state === 'DISPUTE_OPEN' || state === 'DISPUTE_AUTO_DECIDED') && command.type === 'appeal') return 'DISPUTE_APPEAL';
  if ((state === 'DISPUTE_OPEN' || state === 'DISPUTE_AUTO_DECIDED' || state === 'DISPUTE_APPEAL') && command.type === 'finalize') return 'DISPUTE_FINAL';
  return state;
}

export type SanctionLevel = 'NONE' | 'SUSPEND' | 'BAN';

export function sanctionEscalation(current: SanctionLevel, severe = false): SanctionLevel {
  if (severe) return 'BAN';
  if (current === 'NONE') return 'SUSPEND';
  if (current === 'SUSPEND') return 'BAN';
  return 'BAN';
}
