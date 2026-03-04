import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { ZodError, z } from 'zod';
import { FakeMoltbookVerifier, type MoltbookVerifier } from './adapters/moltbook.js';
import { FakeStripeAdapter, type StripeAdapter } from './adapters/stripe.js';
import { FakeTemporalAdapter, type WorkflowAdapter } from './adapters/temporal.js';
import { parseAuthContext } from './core/context.js';
import { DomainError, assertDomain } from './core/errors.js';
import { AuditLedger } from './core/events.js';
import { MarketplaceCore } from './core/marketplace.js';
import { PolicyDecisionService } from './core/policy-decision.js';
import { PolicyEngine } from './core/policy.js';
import { eventToChannel, parseChannelInput } from './core/realtime.js';
import { authFromRequest, clearSessionCookie, issueSessionToken, setSessionCookie } from './core/session.js';
import { createStore } from './core/store.js';
import { ArtifactService } from './services/artifact-service.js';
import { ExecutionService } from './services/execution-service.js';
import { MoltbookIdentityService } from './services/moltbook-identity-service.js';
import { PaymentWebhookService } from './services/payment-webhook-service.js';
import { ReputationService } from './services/reputation-service.js';
import { VaultService } from './services/vault-service.js';
import type { AuthContext, Store } from './types/domain.js';

export type AppServices = {
  store: Store;
  policy: PolicyEngine;
  policyDecision: PolicyDecisionService;
  audit: AuditLedger;
  moltbook: MoltbookVerifier;
  stripe: StripeAdapter;
  workflows: WorkflowAdapter;
  marketplace: MarketplaceCore;
  executionService: ExecutionService;
  artifactService: ArtifactService;
  vaultService: VaultService;
  reputationService: ReputationService;
  paymentWebhookService: PaymentWebhookService;
  identityService: MoltbookIdentityService;
};

export type CreateAppOptions = {
  services?: Partial<AppServices>;
};

const DEFAULT_AUDIENCE = 'clawbot.marketplace.local';

const verifyBodySchema = z.object({
  identityToken: z.string().min(5),
  audience: z.string().min(3).default(DEFAULT_AUDIENCE)
});

const reverifyBodySchema = z.object({
  identityToken: z.string().min(5).optional(),
  audience: z.string().min(3).default(DEFAULT_AUDIENCE)
});

const sessionExchangeBodySchema = z.object({
  identityToken: z.string().min(5),
  role: z.enum(['requester', 'worker', 'moderator', 'admin']).default('worker')
});

const capabilityBodySchema = z.object({
  capabilities: z.array(z.string().min(1)).default([]),
  maxConcurrency: z.number().int().positive().default(1),
  dataClassesAllowed: z.array(z.string().min(1)).default(['public']),
  toolClassesAllowed: z.array(z.string().min(1)).default(['read'])
});

const constitutionBodySchema = z.object({
  constitutionVersion: z.string().min(1)
});

const amountBodySchema = z.object({
  amount: z.number().positive()
});

const createTaskBodySchema = z.object({
  title: z.string().min(3),
  description: z.string().min(3),
  pricingMode: z.enum(['fixed', 'hourly']),
  budget: z.number().positive(),
  deadlineAt: z.string().datetime(),
  scope: z.object({
    allowedDataRefs: z.array(z.string().min(1)).min(1),
    allowedTools: z.array(z.string().min(1)).min(1),
    egressAllowlist: z.array(z.string().min(1)),
    deliverableSchemaRef: z.string().min(1),
    acceptanceTestsRef: z.string().min(1)
  }),
  milestoneNames: z.array(z.string().min(1)).min(1).optional()
});

const idParamsSchema = z.object({
  taskId: z.string().min(1)
});

const contractParamsSchema = z.object({
  contractId: z.string().min(1)
});

const milestoneParamsSchema = z.object({
  contractId: z.string().min(1),
  milestoneId: z.string().min(1)
});

const disputeParamsSchema = z.object({
  disputeId: z.string().min(1)
});

const artifactParamsSchema = z.object({
  artifactId: z.string().min(1)
});

const agentParamsSchema = z.object({
  agentId: z.string().min(1)
});

const bidBodySchema = z.object({
  rate: z.number().positive()
});

const reserveAcceptBodySchema = z.object({
  leaseId: z.string().min(1),
  leaseToken: z.string().min(1)
});

const cancelTaskBodySchema = z.object({
  reasonCode: z.string().min(1).default('REQUESTED_BY_OWNER')
});

const scopeQuerySchema = z.object({
  leaseId: z.string().min(1),
  leaseToken: z.string().min(1)
});

const deliverBodySchema = z.object({
  content: z.string().min(1),
  signature: z.string().min(1),
  artifactId: z.string().min(1).optional()
});

const milestoneAcceptBodySchema = z.object({
  milestoneId: z.string().min(1)
});

const signaturePreviewBodySchema = z.object({
  milestoneId: z.string().min(1),
  content: z.string().min(1)
});

const disputeOpenBodySchema = z.object({
  contractId: z.string().min(1),
  reasonCode: z.string().min(1),
  againstAgentId: z.string().min(1)
});

const disputeResolveBodySchema = z.object({
  ruling: z.enum(['pay_worker', 'refund_requester', 'split']),
  targetAgentId: z.string().min(1)
});

const eventsQuerySchema = z.object({
  entityId: z.string().min(1).optional()
});

const realtimeQuerySchema = z.object({
  channels: z.string().optional(),
  entityId: z.string().min(1).optional()
});

const uploadUrlBodySchema = z.object({
  contractId: z.string().min(1),
  milestoneId: z.string().min(1),
  fileName: z.string().min(1)
});

const finalizeArtifactBodySchema = z.object({
  sha256: z.string().min(16),
  signature: z.string().min(8),
  finalizeToken: z.string().min(1)
});

const vaultTokenBodySchema = z.object({
  leaseId: z.string().min(1),
  leaseToken: z.string().min(1),
  dataRef: z.string().min(1)
});

const policyDecisionBodySchema = z.object({
  action: z.string().min(3),
  context: z.record(z.unknown()).optional()
});

const stripeWebhookBodySchema = z.object({
  type: z.string().min(3),
  data: z.record(z.unknown()).optional()
});

const readinessQuerySchema = z.object({
  role: z.enum(['requester', 'worker', 'moderator', 'admin']).default('worker')
});

const workerEligibilityQuerySchema = z.object({
  agentId: z.string().min(1).optional()
});

function createServices(overrides: Partial<AppServices> = {}): AppServices {
  const store = overrides.store ?? createStore();
  const policy = overrides.policy ?? new PolicyEngine();
  const policyDecision = overrides.policyDecision ?? new PolicyDecisionService(store);
  const audit = overrides.audit ?? new AuditLedger();
  const moltbook = overrides.moltbook ?? new FakeMoltbookVerifier();
  const stripe = overrides.stripe ?? new FakeStripeAdapter();
  const workflows = overrides.workflows ?? new FakeTemporalAdapter();
  const marketplace = overrides.marketplace ?? new MarketplaceCore(store, policy, audit, moltbook, stripe, workflows);
  const executionService = overrides.executionService ?? new ExecutionService(store);
  const artifactService = overrides.artifactService ?? new ArtifactService(store);
  const vaultService = overrides.vaultService ?? new VaultService(store);
  const reputationService = overrides.reputationService ?? new ReputationService(store);
  const paymentWebhookService = overrides.paymentWebhookService ?? new PaymentWebhookService(store);
  const identityService = overrides.identityService ?? new MoltbookIdentityService(store, moltbook);

  return {
    store,
    policy,
    policyDecision,
    audit,
    moltbook,
    stripe,
    workflows,
    marketplace,
    executionService,
    artifactService,
    vaultService,
    reputationService,
    paymentWebhookService,
    identityService
  };
}

function auth(request: FastifyRequest): AuthContext {
  const sessionAuth = authFromRequest(request);
  if (sessionAuth) {
    return sessionAuth;
  }

  return parseAuthContext(request.headers as Record<string, unknown>);
}

function assertRole(actor: AuthContext, roles: AuthContext['role'][]): void {
  assertDomain(roles.includes(actor.role), 'ROLE_FORBIDDEN', 'Forbidden for role.', 403);
}

function assertContractAccess(actor: AuthContext, contract: { requesterAgentId: string; workerAgentId: string }): void {
  if (actor.role === 'admin' || actor.role === 'moderator') {
    return;
  }

  assertDomain(
    actor.actorAgentId === contract.requesterAgentId || actor.actorAgentId === contract.workerAgentId,
    'CONTRACT_FORBIDDEN',
    'Contract access forbidden.',
    403
  );
}

function enforcePolicy(services: AppServices, actor: AuthContext, action: string, context?: Record<string, unknown>) {
  services.policyDecision.enforce({ action, actor, context });
}

function enforceFreshIdentity(services: AppServices, actor: AuthContext): void {
  if (actor.role === 'admin' || actor.role === 'moderator') {
    return;
  }

  services.identityService.assertFreshForPrivileged(actor.actorAgentId);
}

function registerOnboardingRoutes(app: FastifyInstance, services: AppServices) {
  const start = async () => services.marketplace.onboardingStart();

  app.post('/v1/onboarding/start', start);
  app.post('/v1/agents/onboarding/start', start);

  app.post('/v1/identity/moltbook/verify', async (request) => {
    const body = verifyBodySchema.parse(request.body);
    const snapshot = await services.identityService.verify(body.identityToken, body.audience);

    return {
      snapshot,
      activationAllowed: !snapshot.hardBlocked
    };
  });

  const onboardingVerify = async (request: FastifyRequest) => {
    const body = verifyBodySchema.parse(request.body);
    const snapshot = await services.identityService.verify(body.identityToken, body.audience);

    if (snapshot.hardBlocked) {
      throw new DomainError(
        'MOLTBOOK_TRUST_GATE_FAILED',
        snapshot.blockReasons.filter((item) => item.blocking).map((item) => item.message).join(' '),
        403
      );
    }

    const profile = await services.marketplace.verifyMoltbook(body.identityToken, body.audience);

    return {
      ...profile,
      trustTier: snapshot.trustTier,
      snapshot
    };
  };

  app.post('/v1/onboarding/verify', onboardingVerify);
  app.post('/v1/agents/onboarding/verify-moltbook', onboardingVerify);

  app.get('/v1/identity/moltbook/status', async (request) => {
    const actor = auth(request);
    return {
      snapshot: services.identityService.getSnapshot(actor.actorAgentId),
      freshness: services.identityService.getStatus(actor.actorAgentId)
    };
  });

  app.post('/v1/agents/onboarding/capabilities', async (request) => {
    const actor = auth(request);
    const body = capabilityBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'agent.profile.read');
    return services.marketplace.registerCapabilities(actor, body);
  });

  app.post('/v1/agents/me/capabilities', async (request) => {
    const actor = auth(request);
    const body = capabilityBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'agent.profile.read');
    return services.marketplace.registerCapabilities(actor, body);
  });

  const acceptConstitution = async (request: FastifyRequest) => {
    const actor = auth(request);
    const body = constitutionBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'agent.profile.read');
    services.identityService.assertCanActivate(actor.actorAgentId);
    return services.marketplace.acceptConstitution(actor, body.constitutionVersion);
  };

  app.post('/v1/agents/onboarding/accept-constitution', acceptConstitution);
  app.post('/v1/agents/me/constitution/accept', acceptConstitution);

  app.get('/v1/agents/me', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'agent.profile.read');
    return services.marketplace.getAgentProfile(actor);
  });

  app.get('/v1/onboarding/readiness', async (request) => {
    const actor = auth(request);
    const query = readinessQuerySchema.parse(request.query);

    return services.identityService.getOnboardingReadiness(actor.actorAgentId, query.role);
  });

  app.post('/v1/sessions/exchange', async (request, reply) => {
    const body = sessionExchangeBodySchema.parse(request.body);
    const snapshot = await services.identityService.verify(body.identityToken, DEFAULT_AUDIENCE);

    if (snapshot.hardBlocked) {
      throw new DomainError(
        'MOLTBOOK_TRUST_GATE_FAILED',
        snapshot.blockReasons.filter((item) => item.blocking).map((item) => item.message).join(' '),
        403
      );
    }

    const existing = services.store.agents.get(snapshot.agent.id)?.profile;
    const profile = existing ?? (await services.marketplace.verifyMoltbook(body.identityToken, DEFAULT_AUDIENCE));

    const token = issueSessionToken({
      sub: profile.agentId,
      role: body.role,
      ownerRef: snapshot.agent.owner.xHandle,
      riskTier: profile.riskTier,
      trustTier: snapshot.trustTier,
      verifiedAt: snapshot.checkedAt,
      expiresAt: snapshot.expiresAt,
      scopes: ['marketplace:v1']
    });

    setSessionCookie(reply, token);

    return {
      token,
      agentId: profile.agentId,
      role: body.role,
      trustTier: snapshot.trustTier,
      expiresAt: snapshot.expiresAt
    };
  });

  app.post('/v1/sessions/reverify', async (request, reply) => {
    const actor = auth(request);
    const body = reverifyBodySchema.parse(request.body ?? {});
    const snapshot = await services.identityService.reverify(actor.actorAgentId, body.audience, body.identityToken);

    if (snapshot.hardBlocked) {
      throw new DomainError(
        'MOLTBOOK_TRUST_GATE_FAILED',
        snapshot.blockReasons.filter((item) => item.blocking).map((item) => item.message).join(' '),
        403
      );
    }

    const token = issueSessionToken({
      sub: actor.actorAgentId,
      role: actor.role,
      ownerRef: snapshot.agent.owner.xHandle,
      riskTier: services.store.agents.get(actor.actorAgentId)?.profile.riskTier ?? 'LOW',
      trustTier: snapshot.trustTier,
      verifiedAt: snapshot.checkedAt,
      expiresAt: snapshot.expiresAt,
      scopes: ['marketplace:v1']
    });

    setSessionCookie(reply, token);

    return {
      refreshed: true,
      trustTier: snapshot.trustTier,
      expiresAt: snapshot.expiresAt,
      snapshot
    };
  });

  app.post('/v1/sessions/logout', async (_request, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });
}

export async function createApp(options: CreateAppOptions = {}): Promise<{ app: FastifyInstance; services: AppServices }> {
  const services = createServices(options.services);
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: true,
    credentials: true
  });

  await app.register(cookie);
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message
        }
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: error.issues
        }
      });
    }

    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unexpected server error.'
      }
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  registerOnboardingRoutes(app, services);

  app.get('/v1/sanctions/me', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'sanctions.read');
    return services.marketplace.getSanctions(actor);
  });

  app.get('/v1/agents/me/sanctions', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'sanctions.read');
    return services.marketplace.getSanctions(actor);
  });

  app.get('/v1/worker/eligibility', async (request) => {
    const actor = auth(request);
    const query = workerEligibilityQuerySchema.parse(request.query);
    const targetAgentId = actor.role === 'admin' && query.agentId ? query.agentId : actor.actorAgentId;

    if (actor.role !== 'admin') {
      assertDomain(actor.role === 'worker', 'ROLE_FORBIDDEN', 'Only worker role can access worker eligibility.', 403);
    }

    return services.identityService.getWorkerEligibility(targetAgentId);
  });

  app.post('/v1/wallet/topup', async (request) => {
    const actor = auth(request);
    const body = amountBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'wallet.topup');
    return services.marketplace.topup(actor, body.amount);
  });

  app.post('/v1/wallet/topups', async (request) => {
    const actor = auth(request);
    const body = amountBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'wallet.topup');
    return services.marketplace.topup(actor, body.amount);
  });

  app.get('/v1/wallet/balance', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'wallet.ledger.read');
    return { balance: services.marketplace.getBalanceFor(actor) };
  });

  app.get('/v1/wallet/ledger', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'wallet.ledger.read');
    return services.marketplace.getLedger(actor);
  });

  const payoutHandler = async (request: FastifyRequest) => {
    const actor = auth(request);
    const body = amountBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'wallet.payout');
    enforceFreshIdentity(services, actor);

    if (actor.role === 'worker') {
      const eligibility = services.identityService.getWorkerEligibility(actor.actorAgentId);
      assertDomain(eligibility.canPayout, 'WORKER_PAYOUT_BLOCKED', eligibility.blockReasons.map((reason) => reason.message).join(' '), 403);

      const payout = await services.marketplace.payout(actor, body.amount);
      return {
        ...payout,
        trustTier: eligibility.trustTier,
        payoutDelayHours: eligibility.payoutDelayHours,
        riskReviewRequired: eligibility.trustTier === 'B'
      };
    }

    return services.marketplace.payout(actor, body.amount);
  };

  app.post('/v1/wallet/payout', payoutHandler);
  app.post('/v1/wallet/payouts', payoutHandler);

  app.post('/v1/payments/stripe/webhooks', async (request) => {
    const body = stripeWebhookBodySchema.parse(request.body);

    const actor: AuthContext = {
      actorAgentId: 'stripe:webhook',
      role: 'admin'
    };

    enforcePolicy(services, actor, 'payments.webhook', {
      eventType: body.type
    });

    const result = services.paymentWebhookService.handleStripeEvent(body);
    services.audit.publish('payment.webhook_processed', body.type, result as Record<string, unknown>);

    return result;
  });

  app.post('/v1/tasks', async (request) => {
    const actor = auth(request);
    const body = createTaskBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'task.create');
    enforceFreshIdentity(services, actor);
    return services.marketplace.createTask(actor, body);
  });

  app.get('/v1/tasks', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'task.list');
    return { tasks: services.marketplace.listTasks(actor) };
  });

  app.get('/v1/tasks/public', async () => {
    return { tasks: services.marketplace.listPublicTasks() };
  });

  app.get('/v1/tasks/:taskId', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'task.list');
    const { taskId } = idParamsSchema.parse(request.params);
    const task = services.marketplace.getTaskById(taskId);

    if (actor.role === 'admin' || actor.role === 'moderator' || actor.actorAgentId === task.requesterAgentId) {
      return task;
    }

    assertDomain(task.status === 'POSTED' || task.status === 'RESERVED', 'TASK_FORBIDDEN', 'Task access forbidden.', 403);

    return {
      taskId: task.taskId,
      title: task.title,
      pricingMode: task.pricingMode,
      budget: task.budget,
      deadlineAt: task.deadlineAt,
      status: task.status,
      createdAt: task.createdAt
    };
  });

  app.get('/v1/tasks/:taskId/eligibility', async (request) => {
    const actor = auth(request);
    const { taskId } = idParamsSchema.parse(request.params);

    assertDomain(actor.role === 'worker' || actor.role === 'admin', 'ROLE_FORBIDDEN', 'Task eligibility is worker-scoped.', 403);

    const workerId = actor.role === 'admin' ? String((request.query as Record<string, unknown>)?.agentId ?? '') || actor.actorAgentId : actor.actorAgentId;
    return services.identityService.getTaskEligibility(workerId, taskId);
  });

  app.post('/v1/tasks/:taskId/post', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'task.post');
    enforceFreshIdentity(services, actor);
    const { taskId } = idParamsSchema.parse(request.params);
    return services.marketplace.postTask(actor, taskId);
  });

  app.post('/v1/tasks/:taskId/cancel', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'task.cancel');
    enforceFreshIdentity(services, actor);
    const { taskId } = idParamsSchema.parse(request.params);
    const body = cancelTaskBodySchema.parse(request.body ?? {});
    return services.marketplace.cancelTask(actor, taskId, body.reasonCode);
  });

  app.post('/v1/tasks/:taskId/bids', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'bid.create');
    const { taskId } = idParamsSchema.parse(request.params);
    const body = bidBodySchema.parse(request.body);

    if (actor.role === 'worker') {
      const eligibility = services.identityService.getWorkerEligibility(actor.actorAgentId);
      assertDomain(eligibility.canBid, 'WORKER_BID_BLOCKED', eligibility.blockReasons.map((reason) => reason.message).join(' '), 403);
    }

    return services.marketplace.bidTask(actor, taskId, body.rate);
  });

  app.get('/v1/tasks/:taskId/bids', async (request) => {
    const actor = auth(request);
    const { taskId } = idParamsSchema.parse(request.params);
    const task = services.marketplace.getTaskById(taskId);

    const canView = actor.role === 'admin' || actor.role === 'moderator' || actor.actorAgentId === task.requesterAgentId;
    assertDomain(canView, 'BIDS_FORBIDDEN', 'Bids are visible only to requester or moderators.', 403);

    return { bids: services.marketplace.listTaskBids(taskId) };
  });

  app.post('/v1/tasks/:taskId/reserve', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'task.reserve');
    enforceFreshIdentity(services, actor);

    assertDomain(actor.role === 'worker' || actor.role === 'admin', 'ROLE_FORBIDDEN', 'Only workers can reserve tasks.', 403);

    const { taskId } = idParamsSchema.parse(request.params);
    if (actor.role === 'worker') {
      const eligibility = services.identityService.getTaskEligibility(actor.actorAgentId, taskId);
      assertDomain(eligibility.canReserve, 'WORKER_RESERVE_BLOCKED', eligibility.blockReasons.map((reason) => reason.message).join(' '), 403);
    }

    return services.marketplace.reserveTask(actor, taskId);
  });

  app.post('/v1/tasks/:taskId/accept', async (request) => {
    const actor = auth(request);
    enforceFreshIdentity(services, actor);
    const { taskId } = idParamsSchema.parse(request.params);
    const body = reserveAcceptBodySchema.parse(request.body);
    return services.marketplace.acceptTask(actor, taskId, body.leaseId, body.leaseToken);
  });

  app.post('/v1/tasks/:taskId/heartbeat', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'task.heartbeat');
    const { taskId } = idParamsSchema.parse(request.params);
    const body = reserveAcceptBodySchema.parse(request.body);
    return services.marketplace.heartbeat(actor, taskId, body.leaseId, body.leaseToken);
  });

  app.get('/v1/tasks/:taskId/scope', async (request) => {
    const actor = auth(request);
    const { taskId } = idParamsSchema.parse(request.params);
    const query = scopeQuerySchema.parse(request.query);
    enforcePolicy(services, actor, 'task.scope.read', {
      taskId,
      leaseId: query.leaseId
    });
    return services.marketplace.getScopeForLease(actor, taskId, query.leaseId, query.leaseToken);
  });

  app.post('/v1/tasks/:taskId/vault-token', async (request) => {
    const actor = auth(request);
    const { taskId } = idParamsSchema.parse(request.params);
    const body = vaultTokenBodySchema.parse(request.body);

    services.marketplace.getScopeForLease(actor, taskId, body.leaseId, body.leaseToken);

    return services.vaultService.issueVaultToken(actor, {
      taskId,
      leaseId: body.leaseId,
      dataRef: body.dataRef
    });
  });

  app.get('/v1/contracts/:contractId', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'contract.read');
    const { contractId } = contractParamsSchema.parse(request.params);
    const contract = services.marketplace.getContractById(contractId);
    assertContractAccess(actor, contract);
    return contract;
  });

  app.post('/v1/contracts/:contractId/signature-preview', async (request) => {
    const actor = auth(request);
    assertRole(actor, ['worker', 'admin']);

    const { contractId } = contractParamsSchema.parse(request.params);
    const body = signaturePreviewBodySchema.parse(request.body);

    const contract = services.marketplace.getContractById(contractId);
    assertContractAccess(actor, contract);

    return {
      signature: services.marketplace.createDeliverySignature(contractId, body.milestoneId, body.content)
    };
  });

  app.post('/v1/contracts/:contractId/milestones/:milestoneId/start', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'contract.milestone.start');
    enforceFreshIdentity(services, actor);

    const { contractId, milestoneId } = milestoneParamsSchema.parse(request.params);
    const contract = services.marketplace.getContractById(contractId);
    assertContractAccess(actor, contract);

    const started = services.executionService.startMilestone(actor, contract, milestoneId);
    services.audit.publish('execution.started', started.executionId, {
      contractId,
      milestoneId,
      workerAgentId: actor.actorAgentId
    });

    return started;
  });

  app.post('/v1/contracts/:contractId/milestones/:milestoneId/deliver', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'contract.milestone.deliver', {
      contractId: String((request.params as Record<string, unknown>).contractId ?? ''),
      milestoneId: String((request.params as Record<string, unknown>).milestoneId ?? '')
    });
    enforceFreshIdentity(services, actor);

    const { contractId, milestoneId } = milestoneParamsSchema.parse(request.params);
    const body = deliverBodySchema.parse(request.body);

    if (body.artifactId) {
      const artifact = services.artifactService.get(body.artifactId);
      assertDomain(artifact.validationStatus === 'VALID', 'ARTIFACT_NOT_VALID', 'Artifact must be finalized and valid before delivery.', 409);
    }

    const delivered = services.marketplace.deliverMilestone(actor, {
      contractId,
      milestoneId,
      content: body.content,
      signature: body.signature
    });

    services.executionService.closeExecution(contractId, milestoneId);
    return delivered;
  });

  app.post('/v1/contracts/:contractId/milestones/:milestoneId/accept', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'contract.milestone.accept', {
      contractId: String((request.params as Record<string, unknown>).contractId ?? ''),
      milestoneId: String((request.params as Record<string, unknown>).milestoneId ?? '')
    });
    enforceFreshIdentity(services, actor);

    const { contractId, milestoneId } = milestoneParamsSchema.parse(request.params);
    return services.marketplace.acceptMilestone(actor, {
      contractId,
      milestoneId
    });
  });

  app.post('/v1/contracts/:contractId/deliver', async (request) => {
    const actor = auth(request);
    const { contractId } = contractParamsSchema.parse(request.params);
    const body = z.object({ milestoneId: z.string().min(1), content: z.string().min(1), signature: z.string().min(1) }).parse(request.body);

    return services.marketplace.deliverMilestone(actor, {
      contractId,
      milestoneId: body.milestoneId,
      content: body.content,
      signature: body.signature
    });
  });

  app.post('/v1/contracts/:contractId/accept', async (request) => {
    const actor = auth(request);
    const { contractId } = contractParamsSchema.parse(request.params);
    const body = milestoneAcceptBodySchema.parse(request.body);

    return services.marketplace.acceptMilestone(actor, {
      contractId,
      milestoneId: body.milestoneId
    });
  });

  app.post('/v1/artifacts/upload-url', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'artifact.upload_url.create');
    const body = uploadUrlBodySchema.parse(request.body);
    return services.artifactService.createUploadUrl(actor, body);
  });

  app.post('/v1/artifacts/:artifactId/finalize', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'artifact.finalize');
    const { artifactId } = artifactParamsSchema.parse(request.params);
    const body = finalizeArtifactBodySchema.parse(request.body);

    return services.artifactService.finalize(actor, {
      artifactId,
      sha256: body.sha256,
      signature: body.signature,
      finalizeToken: body.finalizeToken
    });
  });

  app.post('/v1/disputes', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'dispute.open');
    const body = disputeOpenBodySchema.parse(request.body);
    return services.marketplace.openDispute(actor, body);
  });

  app.get('/v1/disputes/:disputeId', async (request) => {
    const actor = auth(request);
    const { disputeId } = disputeParamsSchema.parse(request.params);
    const dispute = services.marketplace.getDisputeById(disputeId);

    if (actor.role === 'admin' || actor.role === 'moderator') {
      return dispute;
    }

    const contract = services.marketplace.getContractById(dispute.contractId);
    assertContractAccess(actor, contract);
    return dispute;
  });

  app.get('/v1/disputes/:disputeId/evidence', async (request) => {
    const actor = auth(request);
    const { disputeId } = disputeParamsSchema.parse(request.params);
    const dispute = services.marketplace.getDisputeById(disputeId);
    const contract = services.marketplace.getContractById(dispute.contractId);
    assertContractAccess(actor, contract);

    const evidencePack = [...services.store.evidencePacks.values()].find((candidate) => candidate.disputeId === disputeId) ?? null;
    const artifacts = [...services.store.artifacts.values()].filter((artifact) => artifact.contractId === contract.contractId);

    const events = [
      ...services.marketplace.listEvents(disputeId),
      ...services.marketplace.listEvents(contract.contractId),
      ...services.marketplace.listEvents(contract.taskId)
    ];

    return {
      dispute,
      contract,
      evidencePack,
      artifacts,
      events,
      policyDecisions: services.store.policyDecisions.slice(-50)
    };
  });

  app.post('/v1/disputes/:disputeId/appeal', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'dispute.appeal');
    const { disputeId } = disputeParamsSchema.parse(request.params);
    return services.marketplace.appealDispute(actor, disputeId);
  });

  app.post('/v1/disputes/:disputeId/resolve', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'dispute.resolve', {
      disputeId: String((request.params as Record<string, unknown>).disputeId ?? '')
    });

    const { disputeId } = disputeParamsSchema.parse(request.params);
    const body = disputeResolveBodySchema.parse(request.body);
    return services.marketplace.resolveDispute(actor, disputeId, body.ruling, body.targetAgentId);
  });

  app.get('/v1/reputation/:agentId', async (request) => {
    const actor = auth(request);
    const { agentId } = agentParamsSchema.parse(request.params);
    enforcePolicy(services, actor, 'reputation.read', {
      agentId
    });

    return services.reputationService.get(agentId);
  });

  app.post('/v1/policy/decide', async (request) => {
    const actor = auth(request);
    assertRole(actor, ['moderator', 'admin']);

    const body = policyDecisionBodySchema.parse(request.body);
    return services.policyDecision.decide({
      action: body.action,
      actor,
      context: body.context
    });
  });

  app.get('/v1/policy/decisions', async (request) => {
    const actor = auth(request);
    assertRole(actor, ['moderator', 'admin']);
    return { decisions: services.store.policyDecisions };
  });

  app.get('/v1/events', async (request) => {
    const actor = auth(request);
    const query = eventsQuerySchema.parse(request.query);

    if (query.entityId) {
      enforcePolicy(services, actor, 'audit.read');
      return { events: services.marketplace.listEvents(query.entityId) };
    }

    assertRole(actor, ['moderator', 'admin']);
    return { events: services.marketplace.listAllEvents() };
  });

  app.get('/v1/events/:entityId', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'audit.read');
    const params = z.object({ entityId: z.string().min(1) }).parse(request.params);
    return { events: services.marketplace.listEvents(params.entityId) };
  });

  // TASK-FEAT-006: Audit chain integrity verification
  app.get('/v1/events/verify', async (request) => {
    const actor = auth(request);
    assertRole(actor, ['moderator', 'admin']);
    return services.audit.verifyChain();
  });

  app.get('/v1/events/ws', { websocket: true }, (socket, request) => {
    // BUG-CRIT-001: Authenticate WebSocket connections
    let actor: AuthContext;
    try {
      actor = auth(request);
      enforcePolicy(services, actor, 'audit.read');
    } catch {
      socket.send(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required for WebSocket connection.' } }));
      socket.close(1008, 'Authentication required');
      return;
    }

    const query = eventsQuerySchema.parse(request.query ?? {});

    // Non-admin/non-moderator users can only subscribe to events for entities they own
    // If no entityId is specified by a regular user, they only see events for their own agentId
    const isPrivileged = actor.role === 'admin' || actor.role === 'moderator';

    const unsubscribe = services.audit.subscribe((event) => {
      if (query.entityId && event.entityId !== query.entityId) {
        return;
      }

      // Non-privileged users only receive events related to their own agentId
      if (!isPrivileged && !query.entityId && event.entityId !== actor.actorAgentId) {
        return;
      }

      socket.send(JSON.stringify(event));
    });

    socket.on('close', () => {
      unsubscribe();
    });
  });

  app.get('/v1/realtime', { websocket: true }, (socket, request) => {
    // BUG-CRIT-001: Authenticate WebSocket connections
    let actor: AuthContext;
    try {
      actor = auth(request);
      enforcePolicy(services, actor, 'audit.read');
    } catch {
      socket.send(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required for WebSocket connection.' } }));
      socket.close(1008, 'Authentication required');
      return;
    }

    const query = realtimeQuerySchema.parse(request.query ?? {});
    const channels = parseChannelInput(query.channels);

    const isPrivileged = actor.role === 'admin' || actor.role === 'moderator';

    const unsubscribe = services.audit.subscribe((event) => {
      if (query.entityId && event.entityId !== query.entityId) {
        return;
      }

      // Non-privileged users only receive events related to their own agentId
      if (!isPrivileged && !query.entityId && event.entityId !== actor.actorAgentId) {
        return;
      }

      const channel = eventToChannel(event);
      if (!channels.includes(channel)) {
        return;
      }

      socket.send(
        JSON.stringify({
          channel,
          event
        })
      );
    });

    socket.on('close', () => {
      unsubscribe();
    });
  });

  return { app, services };
}
