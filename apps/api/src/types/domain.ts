import type {
  AgentProfile,
  ArtifactRecord,
  AssignmentLease,
  BidPatternAnalysis,
  CapabilityManifest,
  CollusionAlert,
  ConstitutionAcceptance,
  ConstitutionVersionRecord,
  ContractTerms,
  DataGrant,
  DisputeCase,
  EscrowLock,
  EvidencePack,
  ExecutionSession,
  LedgerEntry,
  MismatchReviewAction,
  MoltbookVerificationSnapshot,
  OwnerMismatchFlag,
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
  /** TASK-HARD-010: Per-milestone random delivery secrets. Key: `${contractId}:${milestoneId}` */
  deliverySecrets: Map<string, string>;
  /** TASK-FEAT-001: Custom milestone names stored at task creation. Key: taskId */
  taskMilestoneNames: Map<string, string[]>;
  /** TASK-HARD-005: Processed Stripe webhook event IDs for idempotency. */
  processedWebhookEventIds: Set<string>;
  /** TASK-HARD-012: Owner mismatch flags for moderation. Key: flagId */
  ownerMismatchFlags: Map<string, OwnerMismatchFlag>;
  /** TASK-HARD-012: Mismatch review actions log. Key: actionId */
  mismatchReviewActions: Map<string, MismatchReviewAction>;
  /** TASK-HARD-014: Processed Moltbook webhook event IDs for replay protection. */
  processedMoltbookWebhookEventIds: Set<string>;
  /** TASK-ENFORCE-001: Constitution version history. Key: version string */
  constitutionVersions: Map<string, ConstitutionVersionRecord>;
  /** TASK-ENFORCE-001: Current active constitution version string */
  currentConstitutionVersion: string;
  /** TASK-ENFORCE-001: Per-agent constitution acceptance records. Key: agentId */
  constitutionAcceptances: Map<string, ConstitutionAcceptance>;
  /** TASK-ENFORCE-006: Ghost reservation tracking. Key: agentId → list of lease outcomes with timestamps */
  leaseOutcomeLog: Map<string, { leaseId: string; outcome: 'EXPIRED' | 'CLOSED'; timestamp: string }[]>;
  /** TASK-ENFORCE-007: Banned owner X handles. Prevents re-registration under new Moltbook accounts. */
  bannedOwnerHandles: Set<string>;
  /** Collusion detection: alerts raised by bid pattern analysis. Key: alertId */
  collusionAlerts: Map<string, CollusionAlert>;
  /** Collusion detection: per-agent bid pattern analysis snapshots. Key: agentId */
  bidPatternAnalyses: Map<string, BidPatternAnalysis>;
};

export type AuthContext = {
  actorAgentId: string;
  role: 'requester' | 'worker' | 'moderator' | 'admin';
};
