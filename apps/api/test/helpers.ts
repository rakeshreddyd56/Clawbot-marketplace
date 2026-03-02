import type { FastifyInstance } from 'fastify';

export type Role = 'requester' | 'worker' | 'moderator' | 'admin';

export function authHeaders(agentId: string, role: Role): Record<string, string> {
  return {
    'x-agent-id': agentId,
    'x-role': role
  };
}

export async function onboardAgent(
  app: FastifyInstance,
  input: {
    tokenSeed: string;
    role: Role;
    capabilities?: string[];
    maxConcurrency?: number;
  }
): Promise<{ agentId: string }> {
  const identityToken = `mbtok_${input.tokenSeed}`;
  const verify = await app.inject({
    method: 'POST',
    url: '/v1/onboarding/verify',
    payload: {
      identityToken,
      audience: 'clawbot.marketplace.local'
    }
  });

  if (verify.statusCode !== 200) {
    throw new Error(`verify failed: ${verify.statusCode} ${verify.body}`);
  }

  const profile = verify.json<{ agentId: string }>();

  const capabilities = await app.inject({
    method: 'POST',
    url: '/v1/agents/me/capabilities',
    headers: authHeaders(profile.agentId, input.role),
    payload: {
      capabilities: input.capabilities ?? ['python'],
      maxConcurrency: input.maxConcurrency ?? 2,
      dataClassesAllowed: ['public', 'internal'],
      toolClassesAllowed: ['read', 'write', 'exec']
    }
  });

  if (capabilities.statusCode !== 200) {
    throw new Error(`capabilities failed: ${capabilities.statusCode} ${capabilities.body}`);
  }

  const constitution = await app.inject({
    method: 'POST',
    url: '/v1/agents/me/constitution/accept',
    headers: authHeaders(profile.agentId, input.role),
    payload: {
      constitutionVersion: 'v1'
    }
  });

  if (constitution.statusCode !== 200) {
    throw new Error(`constitution failed: ${constitution.statusCode} ${constitution.body}`);
  }

  return { agentId: profile.agentId };
}

export async function topup(app: FastifyInstance, agentId: string, role: Role, amount: number): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/wallet/topup',
    headers: authHeaders(agentId, role),
    payload: { amount }
  });

  if (res.statusCode !== 200) {
    throw new Error(`topup failed: ${res.statusCode} ${res.body}`);
  }
}

export async function createPostedTask(
  app: FastifyInstance,
  requesterId: string,
  scopeTool = 'python'
): Promise<{ taskId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: authHeaders(requesterId, 'requester'),
    payload: {
      title: 'Process Dataset',
      description: 'Run dataset cleaning and summary.',
      pricingMode: 'fixed',
      budget: 100,
      deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      scope: {
        allowedDataRefs: ['dataset://tenant-a/input.csv'],
        allowedTools: [scopeTool],
        egressAllowlist: ['api.tenant-a.local'],
        deliverableSchemaRef: 'schema://deliverable/v1',
        acceptanceTestsRef: 'tests://acceptance/v1'
      }
    }
  });

  if (created.statusCode !== 200) {
    throw new Error(`task create failed: ${created.statusCode} ${created.body}`);
  }

  const task = created.json<{ taskId: string }>();

  const posted = await app.inject({
    method: 'POST',
    url: `/v1/tasks/${task.taskId}/post`,
    headers: authHeaders(requesterId, 'requester')
  });

  if (posted.statusCode !== 200) {
    throw new Error(`task post failed: ${posted.statusCode} ${posted.body}`);
  }

  return { taskId: task.taskId };
}
