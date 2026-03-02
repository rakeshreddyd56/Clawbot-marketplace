import type {
  AgentProfile,
  ArtifactRecord,
  AssignmentLease,
  CapabilityManifest,
  ContractTerms,
  DataGrant,
  DisputeCase,
  EscrowLock,
  EvidencePack,
  ExecutionSession,
  LedgerEntry,
  MoltbookVerificationSnapshot,
  PolicyDecision,
  ReputationScore,
  SanctionAction,
  Task,
  TaskScopeManifest,
  VaultToken
} from '@claw/contracts';

export type AgentRecord = {
  profile: AgentProfile;
  capability?: CapabilityManifest;
};

export type Store = {
  agents: Map<string, AgentRecord>;
  tasks: Map<string, Task>;
  scopes: Map<string, TaskScopeManifest>;
  bids: Map<string, { bidId: string; taskId: string; workerAgentId: string; rate: number; createdAt: string }[]>;
  leases: Map<string, AssignmentLease>;
  contracts: Map<string, ContractTerms>;
  artifacts: Map<string, ArtifactRecord>;
  executions: Map<string, ExecutionSession>;
  dataGrants: Map<string, DataGrant>;
  vaultTokens: Map<string, VaultToken>;
  disputes: Map<string, DisputeCase>;
  evidencePacks: Map<string, EvidencePack>;
  reputations: Map<string, ReputationScore>;
  policyDecisions: PolicyDecision[];
  sanctions: Map<string, SanctionAction[]>;
  escrowLocks: Map<string, EscrowLock>;
  moltbookSnapshots: Map<string, MoltbookVerificationSnapshot>;
  historicalOwnerHandles: Map<string, string>;
  lastIdentityTokens: Map<string, string>;
  ledger: LedgerEntry[];
  balances: Map<string, number>;
};

export type AuthContext = {
  actorAgentId: string;
  role: 'requester' | 'worker' | 'moderator' | 'admin';
};
