import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { ZodError, z } from 'zod';
import {
  getSystemPrompt,
  CONSTITUTION_VERSION,
  type PromptContext,
  type WorkerPromptParams
} from '@claw/contracts';
import { FakeMoltbookVerifier, type MoltbookVerifier } from './adapters/moltbook.js';
import { FakeStripeAdapter, WebhookSignatureError, WEBHOOK_MAX_BODY_BYTES, type StripeAdapter } from './adapters/stripe.js';
import { type WorkflowAdapter } from './adapters/temporal.js';
import { createTemporalAdapter } from './adapters/temporal-factory.js';
import { parseAuthContext } from './core/context.js';
import { DomainError, assertDomain } from './core/errors.js';
import { AuditLedger } from './core/events.js';
import { MarketplaceCore } from './core/marketplace.js';
import { PolicyDecisionService } from './core/policy-decision.js';
import { PolicyEngine } from './core/policy.js';
import { eventToChannel, parseChannelInput } from './core/realtime.js';
import { authFromRequest, clearSessionCookie, issueSessionToken, setSessionCookie } from './core/session.js';
import { createStoreFromEnv, loadAuditEventsFromPg, getAuditPersistence } from './core/store-factory.js';
import { createMoltbookCacheFromEnv } from './adapters/moltbook-cache.js';
import { createRedisFromEnv } from './adapters/redis-factory.js';
import { ArtifactService } from './services/artifact-service.js';
import { ExecutionService } from './services/execution-service.js';
import { MoltbookIdentityService } from './services/moltbook-identity-service.js';
import { PaymentWebhookService } from './services/payment-webhook-service.js';
import { ConstitutionService } from './services/constitution-service.js';
import { MoltbookWebhookService } from './services/moltbook-webhook-service.js';
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
  moltbookWebhookService: MoltbookWebhookService;
  constitutionService: ConstitutionService;
};

export type CreateAppOptions = {
  services?: Partial<AppServices>;
  corsOrigins?: string[];
  rateLimit?: { enabled: boolean };
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

const systemPromptQuerySchema = z.object({
  context: z.enum(['session', 'worker', 'requester', 'moderator', 'constitution']).default('session'),
  taskId: z.string().min(1).optional()
});

async function createServices(overrides: Partial<AppServices> = {}): Promise<AppServices> {
  const store = overrides.store ?? await createStoreFromEnv();
  const policy = overrides.policy ?? new PolicyEngine();
  const policyDecision = overrides.policyDecision ?? new PolicyDecisionService(store);
  // TASK-HARD-003: Wire AuditLedger with PostgreSQL persistence.
  // Load existing events from PG to restore the hash chain, and set up
  // write-through so new events are persisted to the audit_events table.
  let audit = overrides.audit;
  if (!audit) {
    const persistence = getAuditPersistence();
    const preloadedEvents = await loadAuditEventsFromPg();
    audit = new AuditLedger({ persistence, preloadedEvents });
  }
  const moltbook = overrides.moltbook ?? new FakeMoltbookVerifier();
  const stripe = overrides.stripe ?? new FakeStripeAdapter();
  const workflows = overrides.workflows ?? createTemporalAdapter();
  const marketplace = overrides.marketplace ?? new MarketplaceCore(store, policy, audit, moltbook, stripe, workflows);
  const executionService = overrides.executionService ?? new ExecutionService(store);
  const artifactService = overrides.artifactService ?? new ArtifactService(store);
  const vaultService = overrides.vaultService ?? new VaultService(store);
  const reputationService = overrides.reputationService ?? new ReputationService(store);
  const paymentWebhookService = overrides.paymentWebhookService ?? new PaymentWebhookService(store);
  // TASK-HARD-013: Create Redis-backed Moltbook snapshot cache (graceful degradation if REDIS_URL unset)
  const redis = createRedisFromEnv();
  const moltbookCache = createMoltbookCacheFromEnv(redis);
  const identityService = overrides.identityService ?? new MoltbookIdentityService(store, moltbook, moltbookCache);
  // TASK-HARD-013: Wire webhook service with Redis cache for real-time cache invalidation
  const moltbookWebhookService = overrides.moltbookWebhookService ?? new MoltbookWebhookService(
    store, audit, undefined, moltbookCache
  );
  const constitutionService = overrides.constitutionService ?? new ConstitutionService(store, audit);

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
    identityService,
    moltbookWebhookService,
    constitutionService
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

/**
 * TASK-ENFORCE-001: Assert that the agent has accepted the current constitution version.
 * Called on all privileged write routes alongside enforceFreshIdentity.
 * Admins and moderators are exempt (they govern the constitution).
 */
function enforceConstitutionCurrent(services: AppServices, actor: AuthContext): void {
  if (actor.role === 'admin' || actor.role === 'moderator') {
    return;
  }

  services.constitutionService.assertConstitutionCurrent(actor.actorAgentId);
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

    // TASK-ENFORCE-001: Record constitution acceptance with version tracking
    services.constitutionService.acceptConstitution(actor.actorAgentId);

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
  const services = await createServices(options.services);
  const app = Fastify({ logger: false });

  // BUG-HIGH-001: Restrict CORS to explicit allowlist instead of reflecting any origin.
  // origin: true (wildcard) with credentials: true enables CSRF on financial endpoints.
  const allowedOrigins = options.corsOrigins
    ?? (process.env.CORS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean))
    ?? ['http://localhost:3001'];

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true
  });

  await app.register(cookie);
  await app.register(websocket);

  // TASK-HARD-005: Capture raw body for Stripe webhook signature verification.
  // This custom content type parser saves the raw body before JSON parsing,
  // which is required for HMAC verification of Stripe webhook payloads.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        const rawBody = typeof body === 'string' ? body : body.toString('utf8');
        // Store raw body on the request for later access in webhook route
        (req as unknown as { rawBody: string }).rawBody = rawBody;
        // For webhook routes, allow non-JSON bodies through (signature verifier handles JSON parsing).
        // For all other routes, parse as normal JSON.
        const isWebhookRoute = req.url?.startsWith('/v1/payments/stripe/webhooks')
          || req.url?.startsWith('/v1/webhooks/moltbook');
        try {
          const parsed = JSON.parse(rawBody);
          done(null, parsed);
        } catch (jsonErr) {
          if (isWebhookRoute) {
            // Pass the raw body through — the webhook handler will verify signature first
            done(null, rawBody);
          } else {
            done(jsonErr as Error, undefined);
          }
        }
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

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

  // ─── TASK-ENFORCE-001: Constitution version management routes ──────────────

  app.get('/v1/constitution/current', async () => {
    return services.constitutionService.getCurrentVersion();
  });

  app.get('/v1/constitution/versions', async (request) => {
    const actor = auth(request);
    assertRole(actor, ['moderator', 'admin']);
    return { versions: services.constitutionService.getVersionHistory() };
  });

  app.get('/v1/agents/me/constitution/status', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'agent.profile.read');
    return services.constitutionService.getAgentConstitutionStatus(actor.actorAgentId);
  });

  app.post('/v1/constitution/upgrade', async (request) => {
    const actor = auth(request);
    assertRole(actor, ['admin']);
    const body = z.object({
      version: z.string().min(1),
      changelog: z.string().min(1),
      constitutionText: z.string().optional()
    }).parse(request.body);

    const result = services.constitutionService.upgradeConstitution(
      body.version,
      body.changelog,
      body.constitutionText
    );

    // Broadcast WebSocket event for constitution update
    services.audit.publish('platform.constitution_updated', 'platform', {
      version: result.version,
      changelog: body.changelog,
      reAcceptanceDeadlineDays: result.reAcceptanceDeadlineDays
    });

    return result;
  });

  app.post('/v1/constitution/enforce-deadlines', async (request) => {
    const actor = auth(request);
    assertRole(actor, ['admin']);
    const suspended = services.constitutionService.enforceReAcceptanceDeadlines();
    return { suspended, count: suspended.length };
  });

  // ─── End constitution routes ───────────────────────────────────────────────

  // ─── TASK-PROMPT-002: System prompt endpoint ──────────────────────────────

  app.get('/v1/agents/me/system-prompt', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'agent.profile.read');
    const query = systemPromptQuerySchema.parse(request.query);
    const promptContext = query.context as PromptContext;

    let prompt: string;

    if (promptContext === 'worker' && query.taskId) {
      // Build worker prompt with task-specific data
      const task = services.marketplace.getTaskById(query.taskId);
      const scope = services.store.scopes.get(task.scopeManifestId);

      // Find an active lease for this worker on this task
      let activeLeaseId = '';
      let activeContractId = '';
      let trustTier = 'C';

      for (const [, lease] of services.store.leases) {
        if (lease.taskId === query.taskId && lease.workerAgentId === actor.actorAgentId && lease.status === 'ACTIVE') {
          activeLeaseId = lease.leaseId;
          break;
        }
      }

      // Find the contract for this task
      for (const [, contract] of services.store.contracts) {
        if (contract.taskId === query.taskId && contract.workerAgentId === actor.actorAgentId) {
          activeContractId = contract.contractId;
          break;
        }
      }

      // Get trust tier from moltbook snapshot (may not exist yet)
      const moltbookSnapshot = services.store.moltbookSnapshots.get(actor.actorAgentId);
      if (moltbookSnapshot) {
        trustTier = moltbookSnapshot.trustTier;
      }

      const workerParams: WorkerPromptParams = {
        taskId: query.taskId,
        contractId: activeContractId || 'pending',
        leaseId: activeLeaseId || 'pending',
        trustTier,
        allowedDataRefs: scope?.allowedDataRefs ?? [],
        allowedTools: scope?.allowedTools ?? [],
        egressAllowlist: scope?.egressAllowlist ?? [],
        deliverableSchemaRef: scope?.deliverableSchemaRef ?? 'none',
        acceptanceTestsRef: scope?.acceptanceTestsRef ?? 'none'
      };

      prompt = getSystemPrompt('worker', workerParams);
    } else if (promptContext === 'worker' && !query.taskId) {
      throw new DomainError(
        'MISSING_TASK_ID',
        'taskId query parameter is required when context is "worker".',
        400
      );
    } else {
      prompt = getSystemPrompt(promptContext);
    }

    services.audit.publish('agent.system_prompt.read', actor.actorAgentId, {
      context: promptContext,
      taskId: query.taskId ?? null
    });

    return {
      prompt,
      context: promptContext,
      constitutionVersion: CONSTITUTION_VERSION,
      injectedAt: new Date().toISOString(),
      agentId: actor.actorAgentId
    };
  });

  // ─── End system prompt route ──────────────────────────────────────────────

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
    // TASK-HARD-013: Check identity freshness BEFORE policy so expired sessions
    // get 401 REVERIFY_REQUIRED (actionable) instead of 403 POLICY_DENY.
    // The policy service also checks IDENTITY_NOT_FRESH for privileged actions,
    // but returns 403 which is less helpful for the frontend reverify flow.
    enforceFreshIdentity(services, actor);
    enforcePolicy(services, actor, 'wallet.payout');
    enforceConstitutionCurrent(services, actor);

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

  // TASK-HARD-005: Stripe webhook with HMAC signature verification + idempotency.
  // Raw body must be captured before JSON parsing for signature verification.
  // The `stripe-signature` header is required and verified against STRIPE_WEBHOOK_SECRET.
  app.post('/v1/payments/stripe/webhooks', {
    config: { rawBody: true }
  }, async (request, reply) => {
    const signatureHeader = request.headers['stripe-signature'] as string | undefined;

    if (!signatureHeader) {
      services.audit.publish('payment.webhook_rejected', 'stripe:webhook', {
        code: 'WEBHOOK_SIGNATURE_MISSING',
        reason: 'Missing stripe-signature header.'
      });
      return reply.status(400).send({
        error: {
          code: 'WEBHOOK_SIGNATURE_MISSING',
          message: 'Missing stripe-signature header. All webhook requests must include a valid Stripe signature.'
        }
      });
    }

    // Capture raw body: Fastify stores it on request.rawBody when configured,
    // or we fall back to serializing the parsed body (for test compatibility).
    const rawBody: string = (request as unknown as { rawBody?: string | Buffer }).rawBody
      ? String((request as unknown as { rawBody?: string | Buffer }).rawBody)
      : JSON.stringify(request.body);

    // Check body size before crypto (hash-DoS mitigation)
    if (Buffer.byteLength(rawBody, 'utf8') > WEBHOOK_MAX_BODY_BYTES) {
      const reason = `Webhook body exceeds maximum allowed size of ${WEBHOOK_MAX_BODY_BYTES} bytes.`;
      services.audit.publish('payment.webhook_rejected', 'stripe:webhook', {
        code: 'WEBHOOK_SIGNATURE_INVALID',
        reason
      });
      return reply.status(400).send({
        error: {
          code: 'WEBHOOK_SIGNATURE_INVALID',
          message: reason
        }
      });
    }

    // Verify the webhook signature using the Stripe adapter
    let event;
    try {
      event = services.stripe.verifyWebhookSignature(rawBody, signatureHeader);
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        services.audit.publish('payment.webhook_rejected', 'stripe:webhook', {
          code: 'WEBHOOK_SIGNATURE_INVALID',
          reason: err.message
        });
        return reply.status(400).send({
          error: {
            code: 'WEBHOOK_SIGNATURE_INVALID',
            message: err.message
          }
        });
      }
      throw err;
    }

    const actor: AuthContext = {
      actorAgentId: 'stripe:webhook',
      role: 'admin'
    };

    enforcePolicy(services, actor, 'payments.webhook', {
      eventType: event.type
    });

    // Bounded idempotency set: evict oldest entries when exceeding limit
    const MAX_PROCESSED_WEBHOOK_IDS = 10_000;
    const idSet = services.store.processedWebhookEventIds;
    if (idSet.size >= MAX_PROCESSED_WEBHOOK_IDS) {
      // Sets iterate in insertion order — evict oldest entries
      const toEvict = idSet.size - MAX_PROCESSED_WEBHOOK_IDS + 1;
      let evicted = 0;
      for (const oldId of idSet) {
        if (evicted >= toEvict) break;
        idSet.delete(oldId);
        evicted++;
      }
    }

    const result = services.paymentWebhookService.handleStripeEvent(event);

    if (!result.duplicate) {
      services.audit.publish('payment.webhook_processed', event.id, result as Record<string, unknown>);
    }

    return {
      ...result,
      processed: !result.duplicate
    };
  });

  // TASK-HARD-013/014: Moltbook webhook with HMAC signature verification.
  // Receives real-time trust tier changes, suspensions, owner changes, and unclaimed events.
  // Invalidates Redis snapshot cache to prevent stale data.
  app.post('/v1/webhooks/moltbook', async (request, reply) => {
    const signatureHeader = (request.headers['moltbook-signature'] as string) ?? '';
    const rawBody = typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body);

    const result = await services.moltbookWebhookService.handleWebhook(rawBody, signatureHeader);

    if (result.processed && !result.duplicate) {
      services.audit.publish('moltbook.webhook_processed', result.eventId ?? 'unknown', {
        action: result.action,
        eventId: result.eventId
      });
    }

    return result;
  });

  app.post('/v1/tasks', async (request) => {
    const actor = auth(request);
    const body = createTaskBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'task.create');
    enforceFreshIdentity(services, actor);
    enforceConstitutionCurrent(services, actor);
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
    enforcePolicy(services, actor, 'task.eligibility.read', { taskId });

    // BUG-MIN-002: Validate agentId query param via Zod instead of raw cast
    const query = workerEligibilityQuerySchema.parse(request.query);
    const workerId = actor.role === 'admin' && query.agentId ? query.agentId : actor.actorAgentId;
    return services.identityService.getTaskEligibility(workerId, taskId);
  });

  app.post('/v1/tasks/:taskId/post', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'task.post');
    enforceFreshIdentity(services, actor);
    enforceConstitutionCurrent(services, actor);
    const { taskId } = idParamsSchema.parse(request.params);
    return services.marketplace.postTask(actor, taskId);
  });

  app.post('/v1/tasks/:taskId/cancel', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'task.cancel');
    enforceFreshIdentity(services, actor);
    enforceConstitutionCurrent(services, actor);
    const { taskId } = idParamsSchema.parse(request.params);
    const body = cancelTaskBodySchema.parse(request.body ?? {});
    return services.marketplace.cancelTask(actor, taskId, body.reasonCode);
  });

  app.post('/v1/tasks/:taskId/bids', async (request) => {
    const actor = auth(request);
    enforcePolicy(services, actor, 'bid.create');
    enforceConstitutionCurrent(services, actor);
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
    enforceConstitutionCurrent(services, actor);

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
    const { taskId } = idParamsSchema.parse(request.params);
    const body = reserveAcceptBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'task.accept', { taskId, leaseId: body.leaseId });
    enforceFreshIdentity(services, actor);
    enforceConstitutionCurrent(services, actor);
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
    enforcePolicy(services, actor, 'vault.token.create', {
      taskId,
      leaseId: body.leaseId,
      dataRef: body.dataRef
    });

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
    const { contractId } = contractParamsSchema.parse(request.params);
    const body = signaturePreviewBodySchema.parse(request.body);
    enforcePolicy(services, actor, 'artifact.signature.preview', {
      contractId,
      milestoneId: body.milestoneId
    });

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
    enforceConstitutionCurrent(services, actor);

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
    enforceConstitutionCurrent(services, actor);

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
    enforceConstitutionCurrent(services, actor);

    const { contractId, milestoneId } = milestoneParamsSchema.parse(request.params);
    return services.marketplace.acceptMilestone(actor, {
      contractId,
      milestoneId
    });
  });

  // BUG-HIGH-002: Legacy deliver/accept routes now enforce policy + identity freshness
  app.post('/v1/contracts/:contractId/deliver', async (request) => {
    const actor = auth(request);
    const { contractId } = contractParamsSchema.parse(request.params);
    enforcePolicy(services, actor, 'contract.milestone.deliver', { contractId });
    enforceFreshIdentity(services, actor);
    enforceConstitutionCurrent(services, actor);
    const body = z.object({ milestoneId: z.string().min(1), content: z.string().min(1), signature: z.string().min(1) }).parse(request.body);

    return services.marketplace.deliverMilestone(actor, {
      contractId,
      milestoneId: body.milestoneId,
      content: body.content,
      signature: body.signature
    });
  });

  // BUG-HIGH-002: Legacy deliver/accept routes now enforce policy + identity freshness
  app.post('/v1/contracts/:contractId/accept', async (request) => {
    const actor = auth(request);
    const { contractId } = contractParamsSchema.parse(request.params);
    enforcePolicy(services, actor, 'contract.milestone.accept', { contractId });
    enforceFreshIdentity(services, actor);
    enforceConstitutionCurrent(services, actor);
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
    enforcePolicy(services, actor, 'dispute.read', { disputeId });
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
    enforcePolicy(services, actor, 'dispute.evidence.read', { disputeId });
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

    // BUG-MED-002: Filter policy decisions to dispute parties only.
    // Admins and moderators see all decisions; dispute parties only see
    // decisions where the actor is a party or the entity is this dispute/contract.
    const isPrivileged = actor.role === 'admin' || actor.role === 'moderator';
    const policyDecisions = isPrivileged
      ? services.store.policyDecisions.slice(-50)
      : services.store.policyDecisions.filter(d =>
          d.actorAgentId === contract.requesterAgentId ||
          d.actorAgentId === contract.workerAgentId ||
          d.entityId === dispute.disputeId ||
          d.entityId === contract.contractId
        ).slice(-50);

    return {
      dispute,
      contract,
      evidencePack,
      artifacts,
      events,
      policyDecisions
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

  // Admin-only endpoint to sweep expired disputes and apply 72h auto-ruling
  app.post('/v1/disputes/sweep', async (request) => {
    const actor = auth(request);
    assertRole(actor, ['admin']);
    const autoRuled = services.marketplace.sweepExpiredDisputes();
    return { swept: autoRuled.length, disputes: autoRuled };
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

  // TASK-HARD-004: Graceful shutdown of Temporal connection on app close
  app.addHook('onClose', async () => {
    if ('close' in services.workflows && typeof services.workflows.close === 'function') {
      await (services.workflows as { close: () => Promise<void> }).close();
    }
  });

  return { app, services };
}
