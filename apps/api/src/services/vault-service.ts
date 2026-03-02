import { DataGrantSchema, VaultTokenSchema } from '@claw/contracts';
import { nowIso, uid } from '@claw/utils';
import type { AuthContext, Store } from '../types/domain.js';
import { assertDomain } from '../core/errors.js';

export class VaultService {
  constructor(private readonly store: Store) {}

  issueVaultToken(actor: AuthContext, input: { taskId: string; leaseId: string; dataRef: string }): { grantId: string; vaultToken: string; expiresAt: string } {
    const task = this.store.tasks.get(input.taskId);
    assertDomain(Boolean(task), 'TASK_NOT_FOUND', 'Task not found.', 404);

    const lease = this.store.leases.get(input.leaseId);
    assertDomain(Boolean(lease), 'LEASE_NOT_FOUND', 'Lease not found.', 404);
    assertDomain(lease!.taskId === input.taskId, 'LEASE_TASK_MISMATCH', 'Lease/task mismatch.', 409);
    assertDomain(lease!.status === 'ACTIVE' || lease!.status === 'CLOSED', 'LEASE_INACTIVE', 'Lease inactive.', 409);

    const ownerAllowed = actor.actorAgentId === task!.requesterAgentId || actor.role === 'admin';
    const workerAllowed = actor.actorAgentId === lease!.workerAgentId;
    assertDomain(ownerAllowed || workerAllowed, 'VAULT_FORBIDDEN', 'Vault access forbidden.', 403);

    const scope = this.store.scopes.get(task!.scopeManifestId);
    assertDomain(Boolean(scope), 'SCOPE_NOT_FOUND', 'Task scope manifest not found.', 404);
    assertDomain(scope!.allowedDataRefs.includes(input.dataRef), 'DATA_REF_FORBIDDEN', 'Data reference not in allowed scope.', 403);

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const grant = DataGrantSchema.parse({
      grantId: uid('grant'),
      taskId: input.taskId,
      workerAgentId: lease!.workerAgentId,
      dataRef: input.dataRef,
      leaseId: input.leaseId,
      expiresAt,
      createdAt: nowIso()
    });

    const tokenRecord = VaultTokenSchema.parse({
      tokenId: uid('vault_tok'),
      grantId: grant.grantId,
      token: uid('vault_access'),
      expiresAt
    });

    this.store.dataGrants.set(grant.grantId, grant);
    this.store.vaultTokens.set(tokenRecord.tokenId, tokenRecord);

    return {
      grantId: grant.grantId,
      vaultToken: tokenRecord.token,
      expiresAt
    };
  }
}
