import {
  AgentProfileSchema,
  ArtifactRecordSchema,
  type AssignmentLease,
  AssignmentLeaseSchema,
  type CapabilityManifest,
  CapabilityManifestSchema,
  ContractTermsSchema,
  DisputeCaseSchema,
  EscrowLockSchema,
  EvidencePackSchema,
  LedgerEntrySchema,
  MilestoneSchema,
  SanctionActionSchema,
  TaskSchema,
  TaskScopeManifestSchema,
  type AgentProfile,
  type ContractTerms,
  type DisputeCase,
  type Task,
  type TaskScopeManifest
} from '@claw/contracts';
import crypto from 'node:crypto';
import { nowIso, sha256, signWithSecret, uid, verifyWithSecret } from '@claw/utils';
import type { MoltbookVerifier } from '../adapters/moltbook.js';
import type { StripeAdapter } from '../adapters/stripe.js';
import type { WorkflowAdapter } from '../adapters/temporal.js';
import type { AuthContext, Store } from '../types/domain.js';
import { AuditLedger } from './events.js';
import { assertDomain, DomainError } from './errors.js';
import { PolicyEngine } from './policy.js';

type CreateTaskInput = {
  title: string;
  description: string;
  pricingMode: 'fixed' | 'hourly';
  budget: number;
  deadlineAt: string;
  scope: {
    allowedDataRefs: string[];
    allowedTools: string[];
    egressAllowlist: string[];
    deliverableSchemaRef: string;
    acceptanceTestsRef: string;
  };
  milestoneNames?: string[];
};

type DeliverInput = {
  contractId: string;
  milestoneId: string;
  content: string;
  signature: string;
};

type AcceptInput = {
  contractId: string;
  milestoneId: string;
};

type DisputeInput = {
  contractId: string;
  reasonCode: string;
  againstAgentId: string;
};

export type PublicTaskCard = Pick<Task, 'taskId' | 'title' | 'pricingMode' | 'budget' | 'deadlineAt' | 'status' | 'createdAt'>;

export class MarketplaceCore {
  private readonly leaseSecrets = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly policy: PolicyEngine,
    private readonly audit: AuditLedger,
    private readonly moltbook: MoltbookVerifier,
    private readonly stripe: StripeAdapter,
    private readonly workflows: WorkflowAdapter
  ) {}

  onboardingStart(): { nonce: string; audience: string } {
    return {
      nonce: uid('nonce'),
      audience: 'clawbot.marketplace.local'
    };
  }

  async verifyMoltbook(identityToken: string, audience: string): Promise<AgentProfile> {
    const verified = await this.moltbook.verify(identityToken, audience);

    assertDomain(verified.isClaimed, 'AGENT_NOT_CLAIMED', 'Agent must be owner-claimed.', 403);
    assertDomain(verified.isActive, 'AGENT_DEACTIVATED', 'Agent is deactivated.', 403);

    const profile = AgentProfileSchema.parse({
      agentId: verified.agentId,
      moltbookAgentId: verified.agentId,
      ownerRef: verified.ownerRef,
      verificationStatus: 'VERIFIED',
      status: 'PENDING_CAPABILITIES',
      riskTier: 'LOW',
      kycTier: 'NONE',
      createdAt: nowIso()
    });

    this.store.agents.set(profile.agentId, { profile });
    this.ensureBalance(profile.agentId);

    this.publish('agent.onboarded', profile.agentId, { ownerRef: profile.ownerRef });
    return profile;
  }

  registerCapabilities(actor: AuthContext, manifest: Omit<ReturnType<typeof CapabilityManifestSchema.parse>, 'attestedAt' | 'agentId'>) {
    const agent = this.getAgent(actor.actorAgentId);
    this.policy.enforce({ action: 'agent.capabilities.write', actor, resourceOwner: agent.profile.agentId });

    const capability = CapabilityManifestSchema.parse({
      agentId: agent.profile.agentId,
      attestedAt: nowIso(),
      ...manifest
    });

    this.store.agents.set(agent.profile.agentId, { ...agent, capability });
    this.publish('agent.capabilities.updated', agent.profile.agentId, {
      maxConcurrency: capability.maxConcurrency,
      capabilities: capability.capabilities
    });

    return capability;
  }

  acceptConstitution(actor: AuthContext, constitutionVersion: string): AgentProfile {
    const agent = this.getAgent(actor.actorAgentId);
    this.policy.enforce({ action: 'agent.constitution.accept', actor, resourceOwner: agent.profile.agentId });

    const profile: AgentProfile = {
      ...agent.profile,
      status: 'ACTIVE'
    };

    this.store.agents.set(profile.agentId, { ...agent, profile });
    this.publish('agent.activated', profile.agentId, { constitutionVersion });

    return profile;
  }

  getAgentProfile(actor: AuthContext): AgentProfile {
    return this.getAgent(actor.actorAgentId).profile;
  }

  async topup(actor: AuthContext, amount: number): Promise<{ topupId: string; balance: number }> {
    assertDomain(amount > 0, 'INVALID_AMOUNT', 'Top-up amount must be > 0.', 400);
    this.requireActive(actor.actorAgentId);

    const resp = await this.stripe.createTopup(actor.actorAgentId, amount);
    assertDomain(resp.status === 'succeeded', 'TOPUP_FAILED', 'Top-up failed.', 502);

    // BUG-MED-005: Double-entry bookkeeping — treasury counterparty for external monetary inflow.
    // treasury:inbound is credited (represents money received from external payment system).
    // Agent account is also credited — total platform assets increase by `amount`.
    this.credit('treasury:inbound', amount, 'wallet.topup', 'topup', resp.topupId);
    this.credit(actor.actorAgentId, amount, 'wallet.topup', 'topup', resp.topupId);
    this.publish('wallet.topped_up', actor.actorAgentId, { amount, topupId: resp.topupId });

    return { topupId: resp.topupId, balance: this.getBalance(actor.actorAgentId) };
  }

  getBalanceFor(actor: AuthContext): number {
    this.ensureBalance(actor.actorAgentId);
    return this.getBalance(actor.actorAgentId);
  }

  createTask(actor: AuthContext, input: CreateTaskInput): Task {
    this.requireRole(actor, ['requester', 'admin']);
    this.requireActive(actor.actorAgentId);

    const scopeManifestId = uid('scope');
    const taskId = uid('task');

    const scope = TaskScopeManifestSchema.parse({
      scopeManifestId,
      allowedDataRefs: input.scope.allowedDataRefs,
      allowedTools: input.scope.allowedTools,
      egressAllowlist: input.scope.egressAllowlist,
      deliverableSchemaRef: input.scope.deliverableSchemaRef,
      acceptanceTestsRef: input.scope.acceptanceTestsRef,
      classification: 'high'
    });

    const task = TaskSchema.parse({
      taskId,
      requesterAgentId: actor.actorAgentId,
      title: input.title,
      description: input.description,
      pricingMode: input.pricingMode,
      budget: input.budget,
      deadlineAt: input.deadlineAt,
      visibility: 'public',
      status: 'DRAFT',
      scopeManifestId,
      createdAt: nowIso()
    });

    this.store.scopes.set(scope.scopeManifestId, scope);
    this.store.tasks.set(task.taskId, task);
    this.store.bids.set(task.taskId, []);

    // TASK-FEAT-001: Persist custom milestone names for use at acceptTask()
    if (input.milestoneNames && input.milestoneNames.length > 0) {
      this.store.taskMilestoneNames.set(task.taskId, input.milestoneNames);
    }

    this.publish('task.created', task.taskId, { requesterAgentId: task.requesterAgentId, budget: task.budget });
    return task;
  }

  listPublicTasks(): PublicTaskCard[] {
    return [...this.store.tasks.values()]
      .filter((task) => task.status === 'POSTED')
      .map((task) => ({
        taskId: task.taskId,
        title: task.title,
        pricingMode: task.pricingMode,
        budget: task.budget,
        deadlineAt: task.deadlineAt,
        status: task.status,
        createdAt: task.createdAt
      }));
  }

  listTasks(actor: AuthContext): Task[] {
    if (actor.role === 'admin' || actor.role === 'moderator') {
      return [...this.store.tasks.values()];
    }

    if (actor.role === 'requester') {
      return [...this.store.tasks.values()].filter((task) => task.requesterAgentId === actor.actorAgentId);
    }

    return [...this.store.tasks.values()].filter((task) => ['POSTED', 'RESERVED'].includes(task.status));
  }

  postTask(actor: AuthContext, taskId: string): Task {
    const task = this.getTask(taskId);
    this.policy.enforce({ action: 'task.post', actor, resourceOwner: task.requesterAgentId });
    assertDomain(task.status === 'DRAFT', 'TASK_INVALID_STATE', 'Task must be DRAFT to post.', 409);

    const updated: Task = { ...task, status: 'POSTED' };
    this.store.tasks.set(taskId, updated);

    this.publish('task.posted', taskId, {});

    // TASK-HARD-004: Start the task lifecycle workflow so it can receive signals
    void this.workflows.startWorkflow('taskLifecycleWorkflow', taskId, [taskId]).catch(() => {
      return; // fire-and-forget — workflow start failure is non-blocking
    });

    return updated;
  }

  bidTask(actor: AuthContext, taskId: string, rate: number): { bidId: string } {
    this.requireRole(actor, ['worker', 'admin']);
    this.requireActive(actor.actorAgentId);

    const task = this.getTask(taskId);
    assertDomain(task.status === 'POSTED', 'TASK_NOT_OPEN', 'Task is not open for bids.', 409);
    assertDomain(rate > 0, 'INVALID_RATE', 'Bid rate must be positive.', 400);

    const bids = this.store.bids.get(taskId) ?? [];
    const bid = {
      bidId: uid('bid'),
      taskId,
      workerAgentId: actor.actorAgentId,
      rate,
      createdAt: nowIso()
    };

    bids.push(bid);
    this.store.bids.set(taskId, bids);

    this.publish('task.bid_placed', taskId, { bidId: bid.bidId, workerAgentId: actor.actorAgentId, rate });
    return { bidId: bid.bidId };
  }

  reserveTask(actor: AuthContext, taskId: string): { leaseId: string; leaseToken: string; expiresAt: string } {
    this.requireRole(actor, ['worker', 'admin']);
    this.requireActive(actor.actorAgentId);

    const task = this.getTask(taskId);
    assertDomain(task.status === 'POSTED', 'TASK_NOT_POSTED', 'Task must be POSTED.', 409);
    assertDomain(actor.actorAgentId !== task.requesterAgentId, 'INVALID_WORKER', 'Requester cannot reserve own task.', 400);

    const bids = this.store.bids.get(taskId) ?? [];
    const hasBid = bids.some((bid) => bid.workerAgentId === actor.actorAgentId);
    assertDomain(hasBid, 'BID_REQUIRED', 'Worker must place a bid before reserving.', 409);

    // TASK-ENFORCE-003: Shill bidding detection — same ownerXHandle cross-check
    const requesterSnapshot = this.store.moltbookSnapshots.get(task.requesterAgentId);
    const workerSnapshot = this.store.moltbookSnapshots.get(actor.actorAgentId);
    if (requesterSnapshot && workerSnapshot) {
      const requesterHandle = requesterSnapshot.agent.owner.xHandle;
      const workerHandle = workerSnapshot.agent.owner.xHandle;
      if (requesterHandle === workerHandle) {
        this.publish('violation.shill_bid_detected', taskId, {
          requesterAgentId: task.requesterAgentId,
          workerAgentId: actor.actorAgentId,
          ownerXHandle: requesterHandle
        });
        assertDomain(false, 'SHILL_BID_DETECTED', 'Requester and worker share the same owner; shill bidding is prohibited.', 403);
      }
    }

    this.assertWorkerEligibleForTask(actor.actorAgentId, taskId);

    const hasActive = [...this.store.leases.values()].some((candidate) => {
      const lease = this.expireLeaseIfStale(candidate);
      return lease.taskId === taskId && lease.status === 'ACTIVE';
    });
    assertDomain(!hasActive, 'TASK_ALREADY_RESERVED', 'Task already has an active reservation.', 409);

    const leaseId = uid('lease');
    const leaseToken = uid('lease_tok');
    const heartbeatIntervalSec = 30;
    const leaseExpiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    const lease = AssignmentLeaseSchema.parse({
      leaseId,
      taskId,
      workerAgentId: actor.actorAgentId,
      leaseExpiresAt,
      heartbeatIntervalSec,
      issuedTokenJti: leaseToken,
      status: 'ACTIVE',
      createdAt: nowIso()
    });

    this.store.leases.set(leaseId, lease);
    this.leaseSecrets.set(leaseId, leaseToken);
    this.store.tasks.set(taskId, { ...task, status: 'RESERVED' });

    this.publish('task.reserved', taskId, { leaseId, workerAgentId: actor.actorAgentId, leaseExpiresAt });
    return { leaseId, leaseToken, expiresAt: leaseExpiresAt };
  }

  acceptTask(actor: AuthContext, taskId: string, leaseId: string, leaseToken: string): ContractTerms {
    const task = this.getTask(taskId);
    this.policy.enforce({ action: 'task.accept', actor, resourceOwner: task.requesterAgentId });
    assertDomain(task.status === 'RESERVED', 'TASK_NOT_RESERVED', 'Task must be RESERVED.', 409);

    const lease = this.expireLeaseIfStale(this.getLease(leaseId));
    assertDomain(lease.taskId === taskId, 'LEASE_TASK_MISMATCH', 'Lease/task mismatch.', 409);
    assertDomain(lease.status !== 'EXPIRED', 'LEASE_EXPIRED', 'Lease has expired.', 409);
    assertDomain(lease.status === 'ACTIVE', 'LEASE_INACTIVE', 'Lease is inactive.', 409);
    assertDomain(lease.workerAgentId !== task.requesterAgentId, 'INVALID_WORKER', 'Requester cannot self-assign.', 400);
    assertDomain(Date.now() <= new Date(lease.leaseExpiresAt).getTime(), 'LEASE_EXPIRED', 'Lease has expired.', 409);
    this.verifyLeaseToken(leaseId, leaseToken);
    this.requireActive(lease.workerAgentId);
    this.assertWorkerEligibleForTask(lease.workerAgentId, taskId);

    const requesterBalance = this.getBalance(task.requesterAgentId);
    assertDomain(requesterBalance >= task.budget, 'INSUFFICIENT_BALANCE', 'Requester has insufficient credits.', 409);

    const contractId = uid('contract');

    // TASK-FEAT-001: Use custom milestone names if provided at task creation (1-10), else default 2-phase split
    const customNames = this.store.taskMilestoneNames.get(taskId);
    const milestoneNames = (customNames && customNames.length > 0) ? customNames : ['Phase 1', 'Phase 2'];
    assertDomain(milestoneNames.length >= 1 && milestoneNames.length <= 10, 'INVALID_MILESTONE_COUNT', 'Milestone count must be 1-10.', 400);

    // Equal split: each milestone gets budget/n; last milestone absorbs rounding remainder
    const perMilestone = Number((task.budget / milestoneNames.length).toFixed(2));
    const milestones = milestoneNames.map((name, idx) =>
      MilestoneSchema.parse({
        milestoneId: uid('ms'),
        contractId,
        name,
        amountCredits: idx === milestoneNames.length - 1
          ? Number((task.budget - perMilestone * (milestoneNames.length - 1)).toFixed(2))
          : perMilestone,
        dueAt: task.deadlineAt,
        acceptanceRuleRef: 'default.acceptance.v1',
        status: idx === 0 ? 'IN_PROGRESS' : 'PENDING'
      })
    );

    const contract = ContractTermsSchema.parse({
      contractId,
      taskId: task.taskId,
      requesterAgentId: task.requesterAgentId,
      workerAgentId: lease.workerAgentId,
      penaltySchedule: {
        latePenaltyPct: 10,
        disputeSlashPct: 20
      },
      constitutionVersion: 'v1',
      signedAt: nowIso(),
      milestones
    });

    // TASK-HARD-010: Generate cryptographically random delivery secret per milestone
    for (const milestone of milestones) {
      const secret = crypto.randomBytes(32).toString('hex');
      this.store.deliverySecrets.set(`${contractId}:${milestone.milestoneId}`, secret);
    }

    this.debit(task.requesterAgentId, task.budget, 'escrow.lock', 'contract', contract.contractId);
    this.credit(this.escrowAccount(contract.contractId), task.budget, 'escrow.lock', 'contract', contract.contractId);

    this.store.contracts.set(contract.contractId, contract);
    this.store.escrowLocks.set(
      contract.contractId,
      EscrowLockSchema.parse({
        escrowId: uid('escrow'),
        contractId: contract.contractId,
        accountId: this.escrowAccount(contract.contractId),
        amount: task.budget,
        status: 'LOCKED',
        createdAt: nowIso(),
        updatedAt: nowIso()
      })
    );
    this.store.leases.set(leaseId, { ...lease, status: 'CLOSED' });
    this.leaseSecrets.delete(leaseId);
    this.store.tasks.set(taskId, { ...task, status: 'ASSIGNED' });

    // TASK-ENFORCE-006: Track successful lease closure for ghost ratio calculation
    this.logLeaseOutcome(lease.workerAgentId, leaseId, 'CLOSED');

    this.publish('contract.created', contract.contractId, {
      taskId,
      requesterAgentId: contract.requesterAgentId,
      workerAgentId: contract.workerAgentId,
      budget: task.budget
    });

    // TASK-HARD-004: Start the contract execution workflow for milestone orchestration
    void this.workflows.startWorkflow('contractExecutionWorkflow', contract.contractId, [{
      contractId: contract.contractId,
      milestoneIds: milestones.map((m) => m.milestoneId)
    }]).catch(() => {
      return; // fire-and-forget — workflow start failure is non-blocking
    });

    return contract;
  }

  heartbeat(actor: AuthContext, taskId: string, leaseId: string, leaseToken: string): { expiresAt: string } {
    const lease = this.expireLeaseIfStale(this.getLease(leaseId));
    assertDomain(lease.taskId === taskId, 'LEASE_TASK_MISMATCH', 'Lease/task mismatch.', 409);
    assertDomain(actor.actorAgentId === lease.workerAgentId, 'LEASE_NOT_OWNER', 'Only lease owner can heartbeat.', 403);
    assertDomain(lease.status !== 'EXPIRED', 'LEASE_EXPIRED', 'Lease has expired.', 409);
    assertDomain(lease.status === 'ACTIVE', 'LEASE_INACTIVE', 'Lease is inactive.', 409);
    this.verifyLeaseToken(leaseId, leaseToken);

    const now = Date.now();
    const expires = new Date(lease.leaseExpiresAt).getTime();
    assertDomain(now <= expires, 'LEASE_EXPIRED', 'Lease has expired.', 409);

    const newExpiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    this.store.leases.set(leaseId, {
      ...lease,
      leaseExpiresAt: newExpiresAt
    });

    this.publish('lease.heartbeat', lease.taskId, { leaseId, workerAgentId: actor.actorAgentId, leaseExpiresAt: newExpiresAt });
    return { expiresAt: newExpiresAt };
  }

  deliverMilestone(actor: AuthContext, input: DeliverInput): { artifactId: string } {
    const contract = this.getContract(input.contractId);
    assertDomain(actor.actorAgentId === contract.workerAgentId, 'NOT_CONTRACT_WORKER', 'Only assigned worker can deliver.', 403);
    this.requireActive(actor.actorAgentId);

    const milestone = contract.milestones.find((m) => m.milestoneId === input.milestoneId);
    assertDomain(Boolean(milestone), 'MILESTONE_NOT_FOUND', 'Milestone not found.', 404);
    assertDomain(milestone!.status === 'IN_PROGRESS', 'MILESTONE_NOT_ACTIVE', 'Milestone not in progress.', 409);

    const payloadHash = sha256(input.content);
    const secret = this.deliverySecret(contract.contractId, input.milestoneId);
    const valid = verifyWithSecret(payloadHash, input.signature, secret);

    assertDomain(valid, 'INVALID_ARTIFACT_SIGNATURE', 'Artifact signature invalid.', 400);

    // TASK-ENFORCE-005: Double-claim artifact detection (Rule F-4)
    // Reject delivery if the same artifact content (SHA256) was already delivered to a different contract
    const existingArtifact = this.findArtifactBySha256(payloadHash, input.contractId);
    if (existingArtifact) {
      this.publish('violation.double_claim_detected', contract.contractId, {
        sha256: payloadHash,
        newContractId: input.contractId,
        newMilestoneId: input.milestoneId,
        workerAgentId: actor.actorAgentId,
        conflictingArtifactId: existingArtifact.artifactId,
        conflictingContractId: existingArtifact.contractId ?? 'unknown'
      });
      throw new DomainError('DUPLICATE_ARTIFACT', `Artifact content already delivered to contract ${existingArtifact.contractId ?? 'unknown'}. Double-claiming is prohibited (Rule F-4).`, 409);
    }

    const artifact = ArtifactRecordSchema.parse({
      artifactId: uid('artifact'),
      executionId: uid('exec'),
      sha256: payloadHash,
      signature: input.signature,
      storageUri: `memory://artifacts/${contract.contractId}/${input.milestoneId}`,
      submittedAt: nowIso(),
      contractId: input.contractId,
      milestoneId: input.milestoneId,
      validationStatus: 'VALID'
    });

    this.store.artifacts.set(artifact.artifactId, artifact);

    const updatedMilestones = contract.milestones.map((m) =>
      m.milestoneId === input.milestoneId ? { ...m, status: 'DELIVERED' as const } : m
    );

    this.store.contracts.set(contract.contractId, { ...contract, milestones: updatedMilestones });

    const task = this.getTask(contract.taskId);
    this.store.tasks.set(task.taskId, { ...task, status: 'DELIVERED' });

    this.publish('milestone.delivered', contract.contractId, {
      milestoneId: input.milestoneId,
      artifactId: artifact.artifactId
    });

    return { artifactId: artifact.artifactId };
  }

  acceptMilestone(actor: AuthContext, input: AcceptInput): ContractTerms {
    const contract = this.getContract(input.contractId);
    this.policy.enforce({ action: 'milestone.accept', actor, resourceOwner: contract.requesterAgentId });

    const milestone = contract.milestones.find((m) => m.milestoneId === input.milestoneId);
    assertDomain(Boolean(milestone), 'MILESTONE_NOT_FOUND', 'Milestone not found.', 404);
    assertDomain(milestone!.status === 'DELIVERED', 'MILESTONE_NOT_DELIVERED', 'Milestone must be DELIVERED.', 409);

    this.debit(this.escrowAccount(contract.contractId), milestone!.amountCredits, 'escrow.release', 'contract', contract.contractId);
    this.credit(contract.workerAgentId, milestone!.amountCredits, 'escrow.release', 'contract', contract.contractId);

    const remainingPending = contract.milestones.filter((m) => m.status !== 'ACCEPTED' && m.milestoneId !== input.milestoneId);
    const updatedMilestones = contract.milestones.map((m) => {
      if (m.milestoneId === input.milestoneId) return { ...m, status: 'ACCEPTED' as const };
      if (m.status === 'PENDING' && remainingPending.length > 0 && remainingPending[0].milestoneId === m.milestoneId) {
        return { ...m, status: 'IN_PROGRESS' as const };
      }
      return m;
    });

    const updatedContract = { ...contract, milestones: updatedMilestones };
    this.store.contracts.set(contract.contractId, updatedContract);

    const allAccepted = updatedMilestones.every((m) => m.status === 'ACCEPTED');
    const task = this.getTask(contract.taskId);
    this.store.tasks.set(task.taskId, {
      ...task,
      status: allAccepted ? 'ACCEPTED' : 'IN_PROGRESS'
    });

    const escrowLock = this.store.escrowLocks.get(contract.contractId);
    if (escrowLock) {
      const balanceLeft = this.getBalance(this.escrowAccount(contract.contractId));
      const nextStatus = balanceLeft <= 0 ? 'RELEASED' : 'PARTIAL_RELEASED';
      this.store.escrowLocks.set(contract.contractId, {
        ...escrowLock,
        amount: balanceLeft,
        status: nextStatus,
        updatedAt: nowIso()
      });
    }

    this.publish('milestone.accepted', contract.contractId, { milestoneId: input.milestoneId, allAccepted });
    return updatedContract;
  }

  openDispute(actor: AuthContext, input: DisputeInput): DisputeCase {
    const contract = this.getContract(input.contractId);
    assertDomain(
      actor.actorAgentId === contract.requesterAgentId || actor.actorAgentId === contract.workerAgentId,
      'NOT_CONTRACT_PARTY',
      'Only contract parties can open dispute.',
      403
    );

    const responseDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const dispute = DisputeCaseSchema.parse({
      disputeId: uid('dispute'),
      contractId: contract.contractId,
      openedBy: actor.actorAgentId,
      reasonCode: input.reasonCode,
      status: 'AUTO_DECIDED',
      autoDecision: `freeze_and_review:${input.againstAgentId}`,
      appealDeadlineAt: responseDeadline,
      responseDeadlineAt: responseDeadline,
      createdAt: nowIso()
    });

    this.store.disputes.set(dispute.disputeId, dispute);

    const task = this.getTask(contract.taskId);
    this.store.tasks.set(task.taskId, { ...task, status: 'DISPUTED' });

    this.publish('dispute.opened', dispute.disputeId, {
      contractId: contract.contractId,
      againstAgentId: input.againstAgentId,
      autoDecision: dispute.autoDecision
    });

    // TASK-HARD-004: Start dispute resolution workflow for appeal window management
    void this.workflows.startWorkflow('disputeResolutionWorkflow', dispute.disputeId, [{
      disputeId: dispute.disputeId,
      contractId: contract.contractId,
      openedBy: actor.actorAgentId
    }]).catch(() => {
      return; // fire-and-forget
    });

    // TASK-HARD-004 + TASK-ENFORCE-004: Start 72h response deadline workflow
    void this.workflows.startWorkflow('disputeDeadlineWorkflow', `deadline:${dispute.disputeId}`, [{
      disputeId: dispute.disputeId,
      contractId: contract.contractId,
      openedBy: actor.actorAgentId,
      againstAgentId: input.againstAgentId
    }]).catch(() => {
      return; // fire-and-forget
    });

    return dispute;
  }

  appealDispute(actor: AuthContext, disputeId: string): DisputeCase {
    const dispute = this.getDispute(disputeId);
    const contract = this.getContract(dispute.contractId);

    assertDomain(
      actor.actorAgentId === contract.requesterAgentId || actor.actorAgentId === contract.workerAgentId,
      'NOT_CONTRACT_PARTY',
      'Only contract parties can appeal.',
      403
    );

    assertDomain(new Date() <= new Date(dispute.appealDeadlineAt), 'APPEAL_WINDOW_CLOSED', 'Appeal window closed.', 409);

    const updated: DisputeCase = {
      ...dispute,
      status: 'UNDER_APPEAL',
      respondedAt: nowIso()
    };

    this.store.disputes.set(disputeId, updated);
    this.publish('dispute.appealed', disputeId, { by: actor.actorAgentId });
    return updated;
  }

  resolveDispute(actor: AuthContext, disputeId: string, ruling: 'pay_worker' | 'refund_requester' | 'split', targetAgentId: string): DisputeCase {
    this.requireRole(actor, ['moderator', 'admin']);
    const dispute = this.getDispute(disputeId);
    const contract = this.getContract(dispute.contractId);

    // BUG-HIGH-003: Validate targetAgentId is a party to the dispute contract.
    // Without this check, a moderator could slash/sanction any arbitrary agent.
    assertDomain(
      targetAgentId === contract.requesterAgentId || targetAgentId === contract.workerAgentId,
      'INVALID_TARGET_AGENT',
      'Target agent must be a party to the dispute contract.',
      400
    );

    const escrowAccount = this.escrowAccount(contract.contractId);
    const escrowBalance = this.getBalance(escrowAccount);

    if (ruling === 'pay_worker') {
      if (escrowBalance > 0) {
        this.debit(escrowAccount, escrowBalance, 'dispute.ruling', 'dispute', disputeId);
        this.credit(contract.workerAgentId, escrowBalance, 'dispute.ruling', 'dispute', disputeId);
      }
    } else if (ruling === 'refund_requester') {
      if (escrowBalance > 0) {
        this.debit(escrowAccount, escrowBalance, 'dispute.ruling', 'dispute', disputeId);
        this.credit(contract.requesterAgentId, escrowBalance, 'dispute.ruling', 'dispute', disputeId);
      }
    } else {
      const half = Number((escrowBalance / 2).toFixed(2));
      const rem = Number((escrowBalance - half).toFixed(2));
      if (escrowBalance > 0) {
        this.debit(escrowAccount, escrowBalance, 'dispute.ruling', 'dispute', disputeId);
        this.credit(contract.requesterAgentId, half, 'dispute.ruling', 'dispute', disputeId);
        this.credit(contract.workerAgentId, rem, 'dispute.ruling', 'dispute', disputeId);
      }
    }

    const penaltyPct = contract.penaltySchedule?.disputeSlashPct ?? 20;
    const slashBase = this.getBalance(targetAgentId);
    const slashAmount = Number((slashBase * (penaltyPct / 100)).toFixed(2));
    if (slashAmount > 0) {
      this.debit(targetAgentId, slashAmount, 'penalty.slash', 'dispute', disputeId);
      this.credit('treasury:slashing', slashAmount, 'penalty.slash', 'dispute', disputeId);
      this.publish('wallet.slashed', targetAgentId, { disputeId, slashAmount, penaltyPct });
    }

    this.applyProgressiveSanction(targetAgentId, 'DISPUTE_BREACH');

    const updated: DisputeCase = {
      ...dispute,
      status: 'FINAL',
      finalRuling: ruling
    };

    this.store.disputes.set(disputeId, updated);

    const evidencePackId = uid('evidence');
    this.store.evidencePacks.set(
      evidencePackId,
      EvidencePackSchema.parse({
        evidencePackId,
        disputeId,
        contractId: contract.contractId,
        artifactIds: [...this.store.artifacts.values()]
          .filter((artifact) => artifact.contractId === contract.contractId)
          .map((artifact) => artifact.artifactId),
        eventIds: this.audit.getByEntity(disputeId).map((event) => event.eventId),
        generatedAt: nowIso()
      })
    );

    const escrowLock = this.store.escrowLocks.get(contract.contractId);
    if (escrowLock) {
      const balanceLeft = this.getBalance(escrowAccount);
      this.store.escrowLocks.set(contract.contractId, {
        ...escrowLock,
        amount: balanceLeft,
        status: balanceLeft > 0 ? 'SLASHED' : 'RELEASED',
        updatedAt: nowIso()
      });
    }

    const task = this.getTask(contract.taskId);
    this.store.tasks.set(task.taskId, { ...task, status: 'RESOLVED' });

    this.publish('dispute.resolved', disputeId, {
      ruling,
      targetAgentId
    });

    return updated;
  }

  /**
   * Sweep expired disputes: auto-rule in favor of the opener when the
   * 72-hour appeal deadline passes without a response (appeal or resolve).
   * Default ruling: refund_requester (opener gets funds back).
   * Returns the list of disputes that were auto-ruled.
   */
  sweepExpiredDisputes(): DisputeCase[] {
    const now = new Date();
    const autoRuled: DisputeCase[] = [];

    for (const dispute of this.store.disputes.values()) {
      // Only auto-rule disputes that are still in AUTO_DECIDED status
      // (i.e. no appeal filed and no moderator resolution yet)
      if (dispute.status !== 'AUTO_DECIDED') continue;

      const deadline = new Date(dispute.responseDeadlineAt ?? dispute.appealDeadlineAt);
      if (now <= deadline) continue;

      // Expired — apply default ruling
      const contract = this.getContract(dispute.contractId);

      // Determine default ruling: refund the opener (requester/worker who filed)
      // and sanction the against-party (extracted from autoDecision field)
      const againstAgentId = dispute.autoDecision?.split(':')[1];
      if (!againstAgentId) continue;

      const escrowAccount = this.escrowAccount(contract.contractId);
      const escrowBalance = this.getBalance(escrowAccount);

      // Default ruling is refund_requester if opener is requester,
      // pay_worker if opener is worker
      const defaultRuling: 'pay_worker' | 'refund_requester' =
        dispute.openedBy === contract.requesterAgentId ? 'refund_requester' : 'pay_worker';

      if (escrowBalance > 0) {
        const recipient = defaultRuling === 'refund_requester'
          ? contract.requesterAgentId
          : contract.workerAgentId;
        this.debit(escrowAccount, escrowBalance, 'dispute.auto_ruling', 'dispute', dispute.disputeId);
        this.credit(recipient, escrowBalance, 'dispute.auto_ruling', 'dispute', dispute.disputeId);
      }

      // Apply penalty slash to the non-responding party
      const penaltyPct = contract.penaltySchedule?.disputeSlashPct ?? 20;
      const slashBase = this.getBalance(againstAgentId);
      const slashAmount = Number((slashBase * (penaltyPct / 100)).toFixed(2));
      if (slashAmount > 0) {
        this.debit(againstAgentId, slashAmount, 'penalty.auto_slash', 'dispute', dispute.disputeId);
        this.credit('treasury:slashing', slashAmount, 'penalty.auto_slash', 'dispute', dispute.disputeId);
        this.publish('wallet.slashed', againstAgentId, {
          disputeId: dispute.disputeId,
          slashAmount,
          penaltyPct,
          reason: 'auto_ruling_no_response'
        });
      }

      // Apply progressive sanction
      this.applyProgressiveSanction(againstAgentId, 'DISPUTE_NO_RESPONSE');

      // Finalize the dispute
      const updated: DisputeCase = {
        ...dispute,
        status: 'FINAL',
        finalRuling: defaultRuling
      };
      this.store.disputes.set(dispute.disputeId, updated);

      // Generate evidence pack
      const evidencePackId = uid('evidence');
      this.store.evidencePacks.set(
        evidencePackId,
        EvidencePackSchema.parse({
          evidencePackId,
          disputeId: dispute.disputeId,
          contractId: contract.contractId,
          artifactIds: [...this.store.artifacts.values()]
            .filter((a) => a.contractId === contract.contractId)
            .map((a) => a.artifactId),
          eventIds: this.audit.getByEntity(dispute.disputeId).map((e) => e.eventId),
          generatedAt: nowIso()
        })
      );

      // Release escrow lock
      const escrowLock = this.store.escrowLocks.get(contract.contractId);
      if (escrowLock) {
        const balanceLeft = this.getBalance(escrowAccount);
        this.store.escrowLocks.set(contract.contractId, {
          ...escrowLock,
          amount: balanceLeft,
          status: balanceLeft > 0 ? 'SLASHED' : 'RELEASED',
          updatedAt: nowIso()
        });
      }

      // Transition task to RESOLVED
      const task = this.getTask(contract.taskId);
      this.store.tasks.set(task.taskId, { ...task, status: 'RESOLVED' });

      // TASK-ENFORCE-004: Emit both the legacy event and the spec-required event
      this.publish('dispute.default_ruling', dispute.disputeId, {
        ruling: defaultRuling,
        targetAgentId: againstAgentId,
        reason: 'RESPONSE_TIMEOUT',
        responseDeadlineAt: dispute.responseDeadlineAt ?? dispute.appealDeadlineAt
      });

      this.publish('dispute.auto_ruled', dispute.disputeId, {
        ruling: defaultRuling,
        targetAgentId: againstAgentId,
        reason: 'RESPONSE_TIMEOUT'
      });

      autoRuled.push(updated);
    }

    return autoRuled;
  }

  listEvents(entityId: string) {
    return this.audit.getByEntity(entityId);
  }

  listAllEvents() {
    return this.audit.getAll();
  }

  getTaskById(taskId: string): Task {
    return this.getTask(taskId);
  }

  cancelTask(actor: AuthContext, taskId: string, reasonCode = 'REQUESTED_BY_OWNER'): Task {
    const task = this.getTask(taskId);
    this.policy.enforce({ action: 'task.cancel', actor, resourceOwner: task.requesterAgentId });
    assertDomain(['DRAFT', 'POSTED', 'RESERVED'].includes(task.status), 'TASK_CANNOT_CANCEL', 'Task cannot be canceled in current state.', 409);

    if (task.status === 'RESERVED') {
      for (const lease of this.store.leases.values()) {
        if (lease.taskId === taskId && lease.status === 'ACTIVE') {
          this.store.leases.set(lease.leaseId, { ...lease, status: 'CLOSED' });
          this.leaseSecrets.delete(lease.leaseId);
        }
      }
    }

    const canceled = {
      ...task,
      status: 'CLOSED' as const
    };
    this.store.tasks.set(taskId, canceled);
    this.publish('task.canceled', taskId, { reasonCode });
    return canceled;
  }

  getScopeForLease(actor: AuthContext, taskId: string, leaseId: string, leaseToken: string): TaskScopeManifest {
    const task = this.getTask(taskId);
    const lease = this.expireLeaseIfStale(this.getLease(leaseId));
    assertDomain(lease.taskId === task.taskId, 'LEASE_TASK_MISMATCH', 'Lease/task mismatch.', 409);
    assertDomain(lease.status !== 'EXPIRED', 'LEASE_EXPIRED', 'Lease has expired.', 409);
    assertDomain(lease.status === 'ACTIVE', 'LEASE_INACTIVE', 'Lease is inactive.', 409);
    assertDomain(Date.now() <= new Date(lease.leaseExpiresAt).getTime(), 'LEASE_EXPIRED', 'Lease has expired.', 409);
    this.verifyLeaseToken(leaseId, leaseToken);

    const actorMatchesLease = actor.actorAgentId === lease.workerAgentId;
    const actorOwnsTask = actor.actorAgentId === task.requesterAgentId;
    assertDomain(actorMatchesLease || actorOwnsTask || actor.role === 'admin', 'SCOPE_FORBIDDEN', 'Scope access forbidden.', 403);

    const scope = this.store.scopes.get(task.scopeManifestId);
    assertDomain(Boolean(scope), 'SCOPE_NOT_FOUND', 'Scope manifest not found.', 404);
    return scope!;
  }

  listTaskBids(taskId: string) {
    return this.store.bids.get(taskId) ?? [];
  }

  getContractById(contractId: string) {
    return this.getContract(contractId);
  }

  getDisputeById(disputeId: string) {
    return this.getDispute(disputeId);
  }

  private publish(eventType: string, entityId: string, payload: Record<string, unknown>): void {
    this.audit.publish(eventType, entityId, payload);
    void this.workflows.signal('marketplace-event', entityId, eventType, payload).catch(() => {
      return;
    });
  }

  private getAgent(agentId: string) {
    const agent = this.store.agents.get(agentId);
    assertDomain(Boolean(agent), 'AGENT_NOT_FOUND', 'Agent not found.', 404);
    return agent!;
  }

  private requireActive(agentId: string): void {
    const agent = this.getAgent(agentId);
    assertDomain(agent.profile.status === 'ACTIVE', 'AGENT_NOT_ACTIVE', 'Agent is not active.', 403);
  }

  private getTask(taskId: string): Task {
    const task = this.store.tasks.get(taskId);
    assertDomain(Boolean(task), 'TASK_NOT_FOUND', 'Task not found.', 404);
    return task!;
  }

  private getLease(leaseId: string) {
    const lease = this.store.leases.get(leaseId);
    assertDomain(Boolean(lease), 'LEASE_NOT_FOUND', 'Lease not found.', 404);
    return lease!;
  }

  private getContract(contractId: string): ContractTerms {
    const contract = this.store.contracts.get(contractId);
    assertDomain(Boolean(contract), 'CONTRACT_NOT_FOUND', 'Contract not found.', 404);
    return contract!;
  }

  private getDispute(disputeId: string): DisputeCase {
    const dispute = this.store.disputes.get(disputeId);
    assertDomain(Boolean(dispute), 'DISPUTE_NOT_FOUND', 'Dispute not found.', 404);
    return dispute!;
  }

  private verifyLeaseToken(leaseId: string, token: string): void {
    const current = this.leaseSecrets.get(leaseId);
    assertDomain(Boolean(current), 'LEASE_TOKEN_MISSING', 'Lease token missing.', 401);
    const expected = Buffer.from(current!);
    const provided = Buffer.from(token);
    // timingSafeEqual requires equal-length buffers; reject mismatched lengths
    const valid = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
    assertDomain(valid, 'LEASE_TOKEN_INVALID', 'Invalid lease token.', 401);
  }

  private expireLeaseIfStale(lease: AssignmentLease): AssignmentLease {
    if (lease.status !== 'ACTIVE') {
      return lease;
    }

    const hasExpired = Date.now() > new Date(lease.leaseExpiresAt).getTime();
    if (!hasExpired) {
      return lease;
    }

    const expiredLease = {
      ...lease,
      status: 'EXPIRED' as const
    };
    this.store.leases.set(lease.leaseId, expiredLease);
    this.leaseSecrets.delete(lease.leaseId);

    const task = this.getTask(lease.taskId);
    if (task.status === 'RESERVED') {
      this.store.tasks.set(task.taskId, { ...task, status: 'POSTED' });
    }

    this.publish('lease.expired', lease.taskId, { leaseId: lease.leaseId });

    // TASK-ENFORCE-006: Track expired lease and check for ghost reservation pattern
    this.logLeaseOutcome(lease.workerAgentId, lease.leaseId, 'EXPIRED');
    this.checkGhostReservation(lease.workerAgentId);

    return expiredLease;
  }

  private getOpenAssignments(workerAgentId: string): number {
    const reservedCount = [...this.store.leases.values()].filter((candidate) => {
      const lease = this.expireLeaseIfStale(candidate);
      return lease.workerAgentId === workerAgentId && lease.status === 'ACTIVE';
    }).length;

    const activeContractIds = new Set(
      [...this.store.contracts.values()]
        .filter((contract) => contract.workerAgentId === workerAgentId)
        .map((contract) => contract.contractId)
    );

    const inFlightTaskCount = [...this.store.tasks.values()].filter((task) => {
      if (!['ASSIGNED', 'IN_PROGRESS', 'DELIVERED', 'DISPUTED'].includes(task.status)) {
        return false;
      }

      return [...activeContractIds].some((contractId) => {
        const contract = this.store.contracts.get(contractId);
        return contract?.taskId === task.taskId;
      });
    }).length;

    return reservedCount + inFlightTaskCount;
  }

  private assertWorkerEligibleForTask(workerAgentId: string, taskId: string): void {
    const agent = this.getAgent(workerAgentId);
    const capability = agent.capability;
    assertDomain(Boolean(capability), 'CAPABILITY_REQUIRED', 'Capability declaration required.', 409);

    const task = this.getTask(taskId);
    const scope = this.store.scopes.get(task.scopeManifestId);
    assertDomain(Boolean(scope), 'SCOPE_NOT_FOUND', 'Scope manifest not found.', 404);

    const workerCapability = capability as CapabilityManifest;
    const hasRequiredTools = scope!.allowedTools.every((tool) => workerCapability.capabilities.includes(tool));
    assertDomain(hasRequiredTools, 'CAPABILITY_MISMATCH', 'Worker missing required tool capability.', 409);

    const openAssignments = this.getOpenAssignments(workerAgentId);
    assertDomain(
      openAssignments < workerCapability.maxConcurrency,
      'WORKER_CAPACITY_EXCEEDED',
      'Worker concurrency limit reached.',
      409
    );
  }

  private ensureBalance(accountId: string): void {
    if (!this.store.balances.has(accountId)) {
      this.store.balances.set(accountId, 0);
    }
  }

  private getBalance(accountId: string): number {
    this.ensureBalance(accountId);
    return this.store.balances.get(accountId)!;
  }

  private debit(accountId: string, amount: number, reason: string, referenceType: string, referenceId: string): void {
    this.ensureBalance(accountId);
    const current = this.getBalance(accountId);
    assertDomain(current >= amount, 'INSUFFICIENT_FUNDS', `Insufficient funds in ${accountId}`, 409);
    this.store.balances.set(accountId, Number((current - amount).toFixed(2)));

    const entry = LedgerEntrySchema.parse({
      entryId: uid('led'),
      accountId,
      direction: 'DEBIT',
      amount,
      assetType: 'credits',
      reason,
      referenceType,
      referenceId,
      createdAt: nowIso()
    });

    this.store.ledger.push(entry);
  }

  private credit(accountId: string, amount: number, reason: string, referenceType: string, referenceId: string): void {
    this.ensureBalance(accountId);
    const current = this.getBalance(accountId);
    this.store.balances.set(accountId, Number((current + amount).toFixed(2)));

    const entry = LedgerEntrySchema.parse({
      entryId: uid('led'),
      accountId,
      direction: 'CREDIT',
      amount,
      assetType: 'credits',
      reason,
      referenceType,
      referenceId,
      createdAt: nowIso()
    });

    this.store.ledger.push(entry);
  }

  private escrowAccount(contractId: string): string {
    return `escrow:${contractId}`;
  }

  /**
   * TASK-HARD-010: Look up the per-milestone random delivery secret from the store.
   * Falls back to a deterministic string only for backward-compat (old contracts created
   * before this fix had no stored secret). New contracts always have a stored secret.
   */
  private deliverySecret(contractId: string, milestoneId: string): string {
    const key = `${contractId}:${milestoneId}`;
    const stored = this.store.deliverySecrets.get(key);
    if (stored) {
      return stored;
    }
    // Legacy fallback for tests / contracts created before TASK-HARD-010
    return `delivery:${contractId}:${milestoneId}`;
  }

  createDeliverySignature(contractId: string, milestoneId: string, content: string): string {
    return signWithSecret(sha256(content), this.deliverySecret(contractId, milestoneId));
  }

  getLedger(actor: AuthContext): { entries: unknown[]; balance: number } {
    this.ensureBalance(actor.actorAgentId);
    const entries = this.store.ledger.filter((x) => x.accountId === actor.actorAgentId);
    return { entries, balance: this.getBalance(actor.actorAgentId) };
  }

  async payout(actor: AuthContext, amount: number) {
    assertDomain(amount > 0, 'INVALID_AMOUNT', 'Payout amount must be >0', 400);
    this.requireActive(actor.actorAgentId);
    const payout = await this.stripe.createPayout(actor.actorAgentId, amount);
    // BUG-MED-005: Double-entry bookkeeping — treasury counterparty for external monetary outflow
    this.debit(actor.actorAgentId, amount, 'wallet.payout_request', 'payout', payout.payoutId);
    this.credit('treasury:outbound', amount, 'wallet.payout_request', 'payout', payout.payoutId);
    this.publish('wallet.payout_requested', actor.actorAgentId, { amount });
    return { status: payout.status, payoutId: payout.payoutId, balance: this.getBalance(actor.actorAgentId) };
  }

  getSanctions(actor: AuthContext) {
    return this.store.sanctions.get(actor.actorAgentId) ?? [];
  }

  private applyProgressiveSanction(agentId: string, reasonCode: string): void {
    const sanctions = this.store.sanctions.get(agentId) ?? [];
    const activeSuspensions = sanctions.filter((s) => s.type === 'SUSPEND').length;

    const sanction =
      activeSuspensions >= 1
        ? SanctionActionSchema.parse({
            sanctionId: uid('sanction'),
            agentId,
            type: 'BAN',
            reasonCode,
            status: 'ACTIVE',
            effectiveAt: nowIso()
          })
        : SanctionActionSchema.parse({
            sanctionId: uid('sanction'),
            agentId,
            type: 'SUSPEND',
            durationHours: 168,
            reasonCode,
            status: 'ACTIVE',
            effectiveAt: nowIso()
          });

    sanctions.push(sanction);
    this.store.sanctions.set(agentId, sanctions);

    const agent = this.getAgent(agentId);
    const nextStatus = sanction.type === 'BAN' ? 'BANNED' : 'SUSPENDED';
    this.store.agents.set(agentId, { ...agent, profile: { ...agent.profile, status: nextStatus } });

    // TASK-ENFORCE-007: Track banned owner handles to prevent re-registration
    if (sanction.type === 'BAN') {
      const snapshot = this.store.moltbookSnapshots.get(agentId);
      if (snapshot?.agent?.owner?.xHandle) {
        this.store.bannedOwnerHandles.add(snapshot.agent.owner.xHandle);
      }
    }

    this.publish('sanction.applied', agentId, { type: sanction.type, reasonCode });
  }

  private requireRole(actor: AuthContext, allowed: AuthContext['role'][]): void {
    if (!allowed.includes(actor.role)) {
      throw new DomainError('ROLE_FORBIDDEN', 'Forbidden for role.', 403);
    }
  }

  /**
   * TASK-ENFORCE-006: Log a lease outcome (EXPIRED or CLOSED) for ghost reservation tracking.
   */
  private logLeaseOutcome(agentId: string, leaseId: string, outcome: 'EXPIRED' | 'CLOSED'): void {
    const log = this.store.leaseOutcomeLog.get(agentId) ?? [];
    log.push({ leaseId, outcome, timestamp: nowIso() });
    this.store.leaseOutcomeLog.set(agentId, log);
  }

  /**
   * TASK-ENFORCE-006: Check if a worker exhibits ghost reservation behavior.
   *
   * Ghost reservation = repeatedly reserving tasks and letting leases expire
   * without ever completing (accepting) the task. This wastes requester time.
   *
   * Detection thresholds:
   * - Minimum 3 lease outcomes before evaluating (avoid penalizing new workers)
   * - Ghost ratio ≥ 60% expired leases triggers auto-sanction
   * - Uses rolling window of last 20 lease outcomes to avoid ancient history bias
   */
  private checkGhostReservation(agentId: string): void {
    const MINIMUM_LEASES = 3;
    const GHOST_RATIO_THRESHOLD = 0.6;
    const ROLLING_WINDOW = 20;

    const fullLog = this.store.leaseOutcomeLog.get(agentId) ?? [];
    if (fullLog.length < MINIMUM_LEASES) {
      return;
    }

    // Use only the most recent outcomes within the rolling window
    const log = fullLog.slice(-ROLLING_WINDOW);
    const expiredCount = log.filter((entry) => entry.outcome === 'EXPIRED').length;
    const ghostRatio = expiredCount / log.length;

    if (ghostRatio < GHOST_RATIO_THRESHOLD) {
      return;
    }

    this.publish('violation.ghost_reservation_detected', agentId, {
      expiredCount,
      totalLeases: log.length,
      ghostRatio: Number(ghostRatio.toFixed(2))
    });

    this.applyProgressiveSanction(agentId, 'GHOST_RESERVATION');
  }

  /**
   * TASK-ENFORCE-005: Find an existing artifact with the same SHA256 hash
   * that belongs to a different contract. Returns the conflicting artifact
   * or undefined if no duplicate exists.
   */
  private findArtifactBySha256(hash: string, currentContractId: string) {
    for (const artifact of this.store.artifacts.values()) {
      if (artifact.sha256 === hash && artifact.contractId !== currentContractId) {
        return artifact;
      }
    }
    return undefined;
  }
}
