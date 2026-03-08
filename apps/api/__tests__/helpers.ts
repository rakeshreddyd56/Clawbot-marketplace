/**
 * Test helpers for Clawbot Marketplace API tests
 * Provides factory functions and shared test utilities
 */
import { type FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { FakeMoltbookVerifier } from '../src/adapters/moltbook.js';
import { FakeStripeAdapter } from '../src/adapters/stripe.js';
import { FakeTemporalAdapter } from '../src/adapters/temporal.js';
import { issueSessionToken } from '../src/core/session.js';

export const TEST_WEBHOOK_SECRET = 'whsec_test_default_secret';

/**
 * Build a fresh app instance with all fake adapters for testing.
 * Rate limiting is disabled by default for tests.
 */
export async function buildTestApp(): Promise<{
  app: FastifyInstance;
  moltbook: FakeMoltbookVerifier;
  stripe: FakeStripeAdapter;
  temporal: FakeTemporalAdapter;
}> {
  const moltbook = new FakeMoltbookVerifier();
  const stripe = new FakeStripeAdapter(TEST_WEBHOOK_SECRET);
  const temporal = new FakeTemporalAdapter();

  const { app } = await createApp({
    services: { moltbook, stripe, workflows: temporal },
    rateLimit: { enabled: false },
  });

  await app.ready();
  return { app, moltbook, stripe, temporal };
}

/**
 * Issue a session JWT for a given agent + role (bypasses Moltbook entirely).
 */
export function makeToken(agentId: string, role: 'requester' | 'worker' | 'moderator' | 'admin' = 'worker'): string {
  return issueSessionToken({ sub: agentId, role });
}

/** Common auth headers using unsigned header-based dev auth (no SESSION_SECRET needed) */
export function headerAuth(agentId: string, role: 'requester' | 'worker' | 'moderator' | 'admin' = 'worker') {
  return { 'x-agent-id': agentId, 'x-role': role };
}

/** Bearer auth header using a session JWT */
export function bearerAuth(agentId: string, role: 'requester' | 'worker' | 'moderator' | 'admin' = 'worker') {
  return { authorization: `Bearer ${makeToken(agentId, role)}` };
}

/** Default task creation payload */
export function makeTaskPayload(overrides?: Record<string, unknown>) {
  return {
    title: 'Test Task',
    description: 'This is a test task description',
    pricingMode: 'fixed',
    budget: 100,
    deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    scope: {
      allowedDataRefs: ['ds://public/test'],
      allowedTools: ['read'],
      egressAllowlist: [],
      deliverableSchemaRef: 'schema://test/v1',
      acceptanceTestsRef: 'tests://test/v1',
    },
    ...overrides,
  };
}

/**
 * Full onboarding helper: verify identity, register capabilities, accept constitution.
 * Returns agentId and auth headers.
 */
export async function onboardAgent(
  app: FastifyInstance,
  identityToken: string,
  role: 'requester' | 'worker' | 'moderator' | 'admin' = 'worker',
  extras?: { constitutionVersion?: string }
): Promise<{ agentId: string; auth: { authorization: string } }> {
  // 1. Verify Moltbook identity
  const verifyRes = await app.inject({
    method: 'POST',
    url: '/v1/onboarding/verify',
    payload: { identityToken, audience: 'clawbot.marketplace.local' },
  });

  if (verifyRes.statusCode !== 200) {
    throw new Error(`Onboarding verify failed: ${verifyRes.statusCode} ${verifyRes.body}`);
  }

  const agentId = JSON.parse(verifyRes.body).snapshot?.agent?.agentId ||
                  JSON.parse(verifyRes.body).agentId;

  // 2. Register capabilities
  await app.inject({
    method: 'POST',
    url: '/v1/agents/onboarding/capabilities',
    headers: headerAuth(agentId, role),
    payload: {
      capabilities: ['text-processing'],
      maxConcurrency: 1,
      dataClassesAllowed: ['public'],
      toolClassesAllowed: ['read'],
    },
  });

  // 3. Accept constitution
  await app.inject({
    method: 'POST',
    url: '/v1/agents/onboarding/accept-constitution',
    headers: headerAuth(agentId, role),
    payload: { constitutionVersion: extras?.constitutionVersion ?? 'v1.0' },
  });

  return { agentId, auth: bearerAuth(agentId, role) };
}

/**
 * Full lifecycle helper: onboard requester & worker, fund requester,
 * create task, post task, worker bids, worker reserves, requester accepts.
 * Returns all relevant IDs.
 */
export async function setupContractLifecycle(app: FastifyInstance) {
  // Onboard requester
  const requester = await onboardAgent(app, 'mbtok_requester_tier_a_001', 'requester');
  // Onboard worker
  const worker = await onboardAgent(app, 'mbtok_worker_tier_a_001', 'worker');

  // Fund requester
  await app.inject({
    method: 'POST',
    url: '/v1/wallet/topup',
    headers: requester.auth,
    payload: { amount: 500 },
  });

  // Create task
  const createRes = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: requester.auth,
    payload: makeTaskPayload({ budget: 100 }),
  });
  const task = JSON.parse(createRes.body);
  const taskId = task.taskId;

  // Post task
  await app.inject({
    method: 'POST',
    url: `/v1/tasks/${taskId}/post`,
    headers: requester.auth,
  });

  // Worker bids
  await app.inject({
    method: 'POST',
    url: `/v1/tasks/${taskId}/bids`,
    headers: worker.auth,
    payload: { rate: 100 },
  });

  // Worker reserves
  const reserveRes = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${taskId}/reserve`,
    headers: worker.auth,
  });
  const { leaseId, leaseToken } = JSON.parse(reserveRes.body);

  // Requester accepts → creates contract
  const acceptRes = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${taskId}/accept`,
    headers: requester.auth,
    payload: { leaseId, leaseToken },
  });
  const contract = JSON.parse(acceptRes.body);

  return {
    requester,
    worker,
    taskId,
    leaseId,
    leaseToken,
    contract,
    contractId: contract.contractId,
  };
}
