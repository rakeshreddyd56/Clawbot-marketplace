import { z } from 'zod';

export const AgentStatusSchema = z.enum(['PENDING_CAPABILITIES', 'ACTIVE', 'SUSPENDED', 'BANNED']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const TrustTierSchema = z.enum(['A', 'B', 'C']);
export type TrustTier = z.infer<typeof TrustTierSchema>;

export const TaskStatusSchema = z.enum([
  'DRAFT',
  'POSTED',
  'RESERVED',
  'ASSIGNED',
  'IN_PROGRESS',
  'DELIVERED',
  'ACCEPTED',
  'DISPUTED',
  'RESOLVED',
  'CLOSED'
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PricingModeSchema = z.enum(['fixed', 'hourly']);
export type PricingMode = z.infer<typeof PricingModeSchema>;

export const AgentProfileSchema = z.object({
  agentId: z.string(),
  moltbookAgentId: z.string(),
  ownerRef: z.string(),
  verificationStatus: z.enum(['VERIFIED', 'UNVERIFIED']),
  status: AgentStatusSchema,
  riskTier: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('LOW'),
  kycTier: z.enum(['NONE', 'BASIC', 'ENHANCED']).default('NONE'),
  createdAt: z.string(),
  /** TASK-ENFORCE-001: Constitution version the agent last accepted */
  constitutionVersionAccepted: z.string().optional(),
  /** TASK-ENFORCE-001: Timestamp when the agent accepted the constitution */
  constitutionAcceptedAt: z.string().optional(),
  /** TASK-ENFORCE-001: Deadline by which agent must re-accept after a constitution upgrade */
  constitutionReAcceptanceDeadline: z.string().optional()
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const CapabilityManifestSchema = z.object({
  agentId: z.string(),
  capabilities: z.array(z.string()).default([]),
  maxConcurrency: z.number().int().positive().default(1),
  dataClassesAllowed: z.array(z.string()).default(['public']),
  toolClassesAllowed: z.array(z.string()).default(['read']),
  attestedAt: z.string()
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export const TaskScopeManifestSchema = z.object({
  scopeManifestId: z.string(),
  allowedDataRefs: z.array(z.string()),
  allowedTools: z.array(z.string()),
  egressAllowlist: z.array(z.string()),
  deliverableSchemaRef: z.string(),
  acceptanceTestsRef: z.string(),
  classification: z.enum(['high'])
});
export type TaskScopeManifest = z.infer<typeof TaskScopeManifestSchema>;

export const TaskSchema = z.object({
  taskId: z.string(),
  requesterAgentId: z.string(),
  title: z.string().min(3),
  description: z.string().min(3),
  pricingMode: PricingModeSchema,
  budget: z.number().positive(),
  deadlineAt: z.string(),
  visibility: z.enum(['public']),
  status: TaskStatusSchema,
  scopeManifestId: z.string(),
  createdAt: z.string()
});
export type Task = z.infer<typeof TaskSchema>;

export const AssignmentLeaseSchema = z.object({
  leaseId: z.string(),
  taskId: z.string(),
  workerAgentId: z.string(),
  leaseExpiresAt: z.string(),
  heartbeatIntervalSec: z.number().int().positive(),
  issuedTokenJti: z.string(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'CLOSED']),
  createdAt: z.string()
});
export type AssignmentLease = z.infer<typeof AssignmentLeaseSchema>;

export const MilestoneSchema = z.object({
  milestoneId: z.string(),
  contractId: z.string(),
  name: z.string(),
  amountCredits: z.number().positive(),
  dueAt: z.string(),
  acceptanceRuleRef: z.string(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'DELIVERED', 'ACCEPTED', 'DISPUTED'])
});
export type Milestone = z.infer<typeof MilestoneSchema>;

export const ContractTermsSchema = z.object({
  contractId: z.string(),
  taskId: z.string(),
  requesterAgentId: z.string(),
  workerAgentId: z.string(),
  penaltySchedule: z
    .object({
      latePenaltyPct: z.number().min(0).max(100).default(10),
      disputeSlashPct: z.number().min(0).max(100).default(20)
    })
    .default({
      latePenaltyPct: 10,
      disputeSlashPct: 20
    }),
  constitutionVersion: z.string(),
  signedAt: z.string(),
  milestones: z.array(MilestoneSchema)
});
export type ContractTerms = z.infer<typeof ContractTermsSchema>;

export const ArtifactRecordSchema = z.object({
  artifactId: z.string(),
  executionId: z.string(),
  sha256: z.string(),
  signature: z.string(),
  storageUri: z.string(),
  submittedAt: z.string(),
  finalizeToken: z.string().optional(),
  contractId: z.string().optional(),
  milestoneId: z.string().optional(),
  validationStatus: z.enum(['VALID', 'INVALID'])
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export const DisputeCaseSchema = z.object({
  disputeId: z.string(),
  contractId: z.string(),
  openedBy: z.string(),
  reasonCode: z.string(),
  status: z.enum(['OPEN', 'AUTO_DECIDED', 'UNDER_APPEAL', 'FINAL']),
  autoDecision: z.string().optional(),
  appealDeadlineAt: z.string(),
  /** TASK-ENFORCE-004: 72h deadline for the target party to respond */
  responseDeadlineAt: z.string().optional(),
  /** TASK-ENFORCE-004: Timestamp when the target party responded (appeal/resolve) */
  respondedAt: z.string().optional(),
  finalRuling: z.string().optional(),
  createdAt: z.string()
});
export type DisputeCase = z.infer<typeof DisputeCaseSchema>;

export const LedgerEntrySchema = z.object({
  entryId: z.string(),
  accountId: z.string(),
  direction: z.enum(['DEBIT', 'CREDIT']),
  amount: z.number().positive(),
  assetType: z.literal('credits'),
  reason: z.string(),
  referenceType: z.string(),
  referenceId: z.string(),
  createdAt: z.string()
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const EscrowLockSchema = z.object({
  escrowId: z.string(),
  contractId: z.string(),
  accountId: z.string(),
  amount: z.number().positive(),
  status: z.enum(['LOCKED', 'PARTIAL_RELEASED', 'RELEASED', 'SLASHED']),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type EscrowLock = z.infer<typeof EscrowLockSchema>;

export const SanctionActionSchema = z.object({
  sanctionId: z.string(),
  agentId: z.string(),
  type: z.enum(['SUSPEND', 'BAN']),
  durationHours: z.number().int().positive().optional(),
  reasonCode: z.string(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'APPEALED', 'REVERSED']),
  effectiveAt: z.string(),
  /** TASK-FEAT-004: Appeal fields */
  appealedAt: z.string().optional(),
  appealReason: z.string().optional(),
  reviewedAt: z.string().optional(),
  reviewedBy: z.string().optional(),
  reviewRuling: z.enum(['UPHELD', 'REVERSED']).optional()
});
export type SanctionAction = z.infer<typeof SanctionActionSchema>;

export const ExecutionSessionSchema = z.object({
  executionId: z.string(),
  contractId: z.string(),
  milestoneId: z.string(),
  sandboxId: z.string(),
  policyVersion: z.string(),
  state: z.enum(['RUNNING', 'HEARTBEAT_TIMEOUT', 'COMPLETED', 'FAILED']),
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  endedAt: z.string().optional()
});
export type ExecutionSession = z.infer<typeof ExecutionSessionSchema>;

export const DataGrantSchema = z.object({
  grantId: z.string(),
  taskId: z.string(),
  workerAgentId: z.string(),
  dataRef: z.string(),
  leaseId: z.string(),
  expiresAt: z.string(),
  createdAt: z.string()
});
export type DataGrant = z.infer<typeof DataGrantSchema>;

export const VaultTokenSchema = z.object({
  tokenId: z.string(),
  grantId: z.string(),
  token: z.string(),
  expiresAt: z.string()
});
export type VaultToken = z.infer<typeof VaultTokenSchema>;

export const EvidencePackSchema = z.object({
  evidencePackId: z.string(),
  disputeId: z.string(),
  contractId: z.string(),
  artifactIds: z.array(z.string()).default([]),
  eventIds: z.array(z.string()).default([]),
  generatedAt: z.string()
});
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

export const ReputationScoreSchema = z.object({
  agentId: z.string(),
  score: z.number().min(0).max(1000),
  factors: z
    .object({
      acceptedMilestones: z.number().int().nonnegative(),
      disputesLost: z.number().int().nonnegative(),
      sanctionsCount: z.number().int().nonnegative(),
      paymentReliability: z.number().min(0).max(1)
    })
    .default({
      acceptedMilestones: 0,
      disputesLost: 0,
      sanctionsCount: 0,
      paymentReliability: 1
    }),
  updatedAt: z.string()
});
export type ReputationScore = z.infer<typeof ReputationScoreSchema>;

export const PolicyDecisionSchema = z.object({
  decisionId: z.string(),
  policyVersion: z.string(),
  action: z.string(),
  actorAgentId: z.string(),
  entityId: z.string().optional(),
  allow: z.boolean(),
  reason: z.string(),
  contextHash: z.string(),
  createdAt: z.string()
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const ActionBlockReasonSchema = z.object({
  code: z.enum([
    'TOKEN_INVALID',
    'TOKEN_EXPIRED',
    'BOT_NOT_CLAIMED',
    'OWNER_NOT_VERIFIED',
    'OWNER_MISMATCH',
    'TRUST_TIER_LIMITED',
    'SANCTIONED',
    'MISSING_CAPABILITIES',
    'ROLE_NOT_ALLOWED',
    'CONSTITUTION_OUTDATED'
  ]),
  message: z.string(),
  blocking: z.boolean()
});
export type ActionBlockReason = z.infer<typeof ActionBlockReasonSchema>;

export const MoltbookVerificationSnapshotSchema = z.object({
  valid: z.boolean(),
  checkedAt: z.string(),
  trustedUntilAt: z.string(),
  expiresAt: z.string(),
  trustTier: TrustTierSchema,
  hardBlocked: z.boolean(),
  blockReasons: z.array(ActionBlockReasonSchema),
  agent: z.object({
    id: z.string(),
    name: z.string(),
    karma: z.number().int().nonnegative(),
    isClaimed: z.boolean(),
    stats: z.object({
      posts: z.number().int().nonnegative(),
      comments: z.number().int().nonnegative()
    }),
    owner: z.object({
      xVerified: z.boolean(),
      xHandle: z.string()
    })
  })
});
export type MoltbookVerificationSnapshot = z.infer<typeof MoltbookVerificationSnapshotSchema>;

export const VerificationFreshnessSchema = z.object({
  checkedAt: z.string(),
  trustedUntilAt: z.string(),
  expiresAt: z.string(),
  needsReverifyPrompt: z.boolean(),
  expired: z.boolean(),
  secondsToExpiry: z.number().int(),
  trustTier: TrustTierSchema,
  hardBlocked: z.boolean()
});
export type VerificationFreshness = z.infer<typeof VerificationFreshnessSchema>;

export const OnboardingReadinessItemSchema = z.object({
  id: z.enum([
    'identity_verified',
    'trust_gate',
    'capabilities_declared',
    'constitution_accepted',
    'sandbox_eligible',
    'vault_ready',
    'payout_eligible'
  ]),
  label: z.string(),
  status: z.enum(['PASS', 'WARN', 'BLOCKED']),
  details: z.string()
});
export type OnboardingReadinessItem = z.infer<typeof OnboardingReadinessItemSchema>;

export const WorkerEligibilitySchema = z.object({
  agentId: z.string(),
  trustTier: TrustTierSchema,
  canBid: z.boolean(),
  canReserve: z.boolean(),
  canPayout: z.boolean(),
  payoutDelayHours: z.number().int().nonnegative(),
  blockReasons: z.array(ActionBlockReasonSchema)
});
export type WorkerEligibility = z.infer<typeof WorkerEligibilitySchema>;

export const AuditEventSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  entityId: z.string(),
  payload: z.record(z.any()),
  timestamp: z.string(),
  previousHash: z.string(),
  hash: z.string()
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ─── TASK-HARD-012: Owner mismatch moderation schemas ───────────────────────

export const OwnerMismatchFlagSchema = z.object({
  flagId: z.string(),
  agentId: z.string(),
  previousHandle: z.string(),
  newHandle: z.string(),
  detectedAt: z.string(),
  resolvedAt: z.string().optional(),
  resolution: z.enum(['cleared', 'banned']).optional(),
  resolvedBy: z.string().optional()
});
export type OwnerMismatchFlag = z.infer<typeof OwnerMismatchFlagSchema>;

export const MismatchReviewActionSchema = z.object({
  actionId: z.string(),
  flagId: z.string(),
  moderatorId: z.string(),
  actionType: z.enum(['cleared', 'banned']),
  notes: z.string().optional(),
  actedAt: z.string()
});
export type MismatchReviewAction = z.infer<typeof MismatchReviewActionSchema>;

// ─── TASK-HARD-014: Moltbook webhook event schemas ──────────────────────────

export const MoltbookWebhookEventSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  timestamp: z.string(),
  agentId: z.string(),
  payload: z.record(z.unknown())
});
export type MoltbookWebhookEvent = z.infer<typeof MoltbookWebhookEventSchema>;

export const MoltbookTrustTierChangedPayloadSchema = z.object({
  previousTier: TrustTierSchema,
  newTier: TrustTierSchema,
  karma: z.number(),
  posts: z.number(),
  comments: z.number()
});

export const MoltbookSuspendedPayloadSchema = z.object({
  reason: z.string(),
  suspendedAt: z.string()
});

export const MoltbookOwnerChangedPayloadSchema = z.object({
  previousOwnerHandle: z.string(),
  newOwnerHandle: z.string()
});

export const MoltbookUnclaimedPayloadSchema = z.object({
  unclaimedAt: z.string()
});

export type MoltbookWebhookResult = {
  accepted: boolean;
  action: string;
  processed: boolean;
  duplicate?: boolean;
  eventId: string;
};

// ─── TASK-ENFORCE-001: Constitution version tracking ─────────────────────────

export const ConstitutionVersionRecordSchema = z.object({
  version: z.string(),
  publishedAt: z.string(),
  sha256Hash: z.string(),
  changelog: z.string(),
  reAcceptanceDeadlineDays: z.number().int().positive().default(7)
});
export type ConstitutionVersionRecord = z.infer<typeof ConstitutionVersionRecordSchema>;

// ─── Constitution Schemas ────────────────────────────────────────────────────
// Added by rataa-research agent per research recommendation (Section 7.1.2)

export const ConstitutionRuleCategorySchema = z.enum([
  'identity',
  'conduct',
  'financial',
  'data',
  'dispute',
  'platform'
]);
export type ConstitutionRuleCategory = z.infer<typeof ConstitutionRuleCategorySchema>;

export const ConstitutionRuleSchema = z.object({
  ruleId: z.string(),
  category: ConstitutionRuleCategorySchema,
  title: z.string(),
  text: z.string()
});
export type ConstitutionRule = z.infer<typeof ConstitutionRuleSchema>;

export const ConstitutionSchema = z.object({
  version: z.string(),
  acceptedAt: z.string(),
  agentId: z.string(),
  constitutionHash: z.string(),
  rules: z.array(ConstitutionRuleSchema)
});
export type Constitution = z.infer<typeof ConstitutionSchema>;

export const ConstitutionAcceptanceSchema = z.object({
  agentId: z.string(),
  constitutionVersion: z.string(),
  constitutionHash: z.string(),
  acceptedAt: z.string(),
  ipHash: z.string().optional(),
  auditEventId: z.string().optional()
});
export type ConstitutionAcceptance = z.infer<typeof ConstitutionAcceptanceSchema>;

// ─── Collusion Detection (Rules C-3, C-7, M-3, M-8) ────────────────────────

export const CollusionAlertTypeSchema = z.enum([
  'SHILL_BIDDING',           // Agent bidding on own tasks via related identity
  'RING_TRADING',            // Two+ agents repeatedly exchanging tasks to farm reputation
  'PRICE_FIXING',            // Coordinated bid amounts across multiple agents
  'GHOST_BIDDING',           // Bidding without intent to complete (low bid-to-completion ratio)
  'REPUTATION_FARMING',      // Artificial activity inflation (small tasks, instant accept)
  'IDENTITY_ROTATION'        // Multiple accounts from same owner for marketplace manipulation
]);
export type CollusionAlertType = z.infer<typeof CollusionAlertTypeSchema>;

export const CollusionAlertSchema = z.object({
  alertId: z.string(),
  alertType: CollusionAlertTypeSchema,
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  agentIds: z.array(z.string()),
  evidence: z.object({
    description: z.string(),
    dataPoints: z.array(z.object({
      metric: z.string(),
      value: z.union([z.string(), z.number()]),
      threshold: z.union([z.string(), z.number()]).optional()
    })),
    relatedTaskIds: z.array(z.string()).optional(),
    relatedContractIds: z.array(z.string()).optional()
  }),
  status: z.enum(['OPEN', 'INVESTIGATING', 'CONFIRMED', 'DISMISSED']),
  detectedAt: z.string(),
  resolvedAt: z.string().optional(),
  resolvedBy: z.string().optional(),
  resolution: z.string().optional(),
  autoSanctioned: z.boolean().default(false)
});
export type CollusionAlert = z.infer<typeof CollusionAlertSchema>;

export const BidPatternAnalysisSchema = z.object({
  agentId: z.string(),
  windowStartAt: z.string(),
  windowEndAt: z.string(),
  totalBids: z.number(),
  completedTasks: z.number(),
  abandonedLeases: z.number(),
  bidToCompletionRatio: z.number(),
  uniqueCounterparties: z.number(),
  avgBidAmount: z.number(),
  repeatedCounterpartyPairs: z.array(z.object({
    counterpartyId: z.string(),
    interactions: z.number()
  })),
  suspicionScore: z.number().min(0).max(100),
  analyzedAt: z.string()
});
export type BidPatternAnalysis = z.infer<typeof BidPatternAnalysisSchema>;

// ─── System Prompts ─────────────────────────────────────────────────────────
export {
  CONSTITUTION_VERSION,
  CONSTITUTION_HASH,
  INSTITUTION_RULES,
  UNIVERSAL_SYSTEM_PROMPT,
  REQUESTER_SYSTEM_PROMPT,
  MODERATOR_SYSTEM_PROMPT,
  buildWorkerSystemPrompt,
  buildConstitutionPrompt,
  getSystemPrompt,
  type RuleCategory,
  type InstitutionRule,
  type WorkerPromptParams,
  type PromptContext
} from './system-prompts.js';
