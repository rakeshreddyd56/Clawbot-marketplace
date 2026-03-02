import { ArtifactRecordSchema } from '@claw/contracts';
import { nowIso, uid } from '@claw/utils';
import type { AuthContext, Store } from '../types/domain.js';
import { assertDomain } from '../core/errors.js';

export class ArtifactService {
  constructor(private readonly store: Store) {}

  createUploadUrl(actor: AuthContext, input: { contractId: string; milestoneId: string; fileName: string }): { artifactId: string; uploadUrl: string; finalizeToken: string } {
    const contract = this.store.contracts.get(input.contractId);
    assertDomain(Boolean(contract), 'CONTRACT_NOT_FOUND', 'Contract not found.', 404);
    assertDomain(actor.actorAgentId === contract!.workerAgentId || actor.role === 'admin', 'ARTIFACT_FORBIDDEN', 'Only assigned worker can create artifact upload.', 403);

    const milestone = contract!.milestones.find((item) => item.milestoneId === input.milestoneId);
    assertDomain(Boolean(milestone), 'MILESTONE_NOT_FOUND', 'Milestone not found.', 404);

    const artifactId = uid('artifact');
    const finalizeToken = uid('artifact_final');
    const storageUri = `s3://artifact-vault/${contract!.contractId}/${artifactId}/${input.fileName}`;

    const record = ArtifactRecordSchema.parse({
      artifactId,
      executionId: uid('exec_placeholder'),
      sha256: 'pending',
      signature: 'pending',
      storageUri,
      submittedAt: nowIso(),
      finalizeToken,
      contractId: input.contractId,
      milestoneId: input.milestoneId,
      validationStatus: 'INVALID'
    });

    this.store.artifacts.set(artifactId, record);

    return {
      artifactId,
      uploadUrl: `https://uploads.clawbot.local/${artifactId}`,
      finalizeToken
    };
  }

  finalize(actor: AuthContext, input: { artifactId: string; sha256: string; signature: string; finalizeToken: string }): { artifactId: string; validationStatus: 'VALID' | 'INVALID' } {
    const record = this.store.artifacts.get(input.artifactId);
    assertDomain(Boolean(record), 'ARTIFACT_NOT_FOUND', 'Artifact not found.', 404);

    const contractId = record!.contractId;
    assertDomain(Boolean(contractId), 'ARTIFACT_CONTRACT_MISSING', 'Artifact contract context missing.', 409);

    const contract = this.store.contracts.get(contractId!);
    assertDomain(Boolean(contract), 'CONTRACT_NOT_FOUND', 'Contract not found.', 404);

    assertDomain(actor.actorAgentId === contract!.workerAgentId || actor.role === 'admin', 'ARTIFACT_FORBIDDEN', 'Only assigned worker can finalize artifact.', 403);
    assertDomain(record!.finalizeToken === input.finalizeToken, 'ARTIFACT_FINALIZE_TOKEN_INVALID', 'Invalid finalize token.', 401);

    const valid = input.signature.length > 10 && input.sha256.length >= 32;
    const finalized = {
      ...record!,
      sha256: input.sha256,
      signature: input.signature,
      validationStatus: valid ? ('VALID' as const) : ('INVALID' as const),
      submittedAt: nowIso(),
      finalizeToken: undefined
    };

    this.store.artifacts.set(input.artifactId, finalized);

    return {
      artifactId: input.artifactId,
      validationStatus: finalized.validationStatus
    };
  }

  get(artifactId: string) {
    const record = this.store.artifacts.get(artifactId);
    assertDomain(Boolean(record), 'ARTIFACT_NOT_FOUND', 'Artifact not found.', 404);
    return record!;
  }
}
