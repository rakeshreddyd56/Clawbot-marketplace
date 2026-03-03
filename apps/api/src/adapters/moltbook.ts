import { DomainError } from '../core/errors.js';

export type VerifiedIdentity = {
  valid: boolean;
  checkedAt: string;
  expiresAt: string;
  agentId: string;
  agentName: string;
  karma: number;
  posts: number;
  comments: number;
  ownerXVerified: boolean;
  ownerXHandle: string;
  ownerRef: string;
  isClaimed: boolean;
  isActive: boolean;
};

export interface MoltbookVerifier {
  verify(identityToken: string, audience: string): Promise<VerifiedIdentity>;
}

export class FakeMoltbookVerifier implements MoltbookVerifier {
  async verify(identityToken: string, audience: string): Promise<VerifiedIdentity> {
    if (!identityToken.startsWith('mbtok_')) {
      throw new DomainError('INVALID_IDENTITY_TOKEN', 'Identity token is invalid.', 401);
    }

    if (!audience || audience.length < 3) {
      throw new DomainError('AUDIENCE_REQUIRED', 'Audience is required.', 400);
    }

    const tokenLower = identityToken.toLowerCase();

    // TASK-TEST-001: Support owner_alt_ prefix for owner mismatch testing.
    // Tokens like `mbtok_owner_alt_SEED` strip `owner_alt_` for agentId derivation
    // so the SAME underlying agent can appear with a different ownerXHandle on reverify.
    const agentTokenBase = identityToken.replace(/owner_alt_/gi, '');
    const agentId = agentTokenBase.replace('mbtok_', 'agent_');

    const valid = !tokenLower.includes('invalid');
    const isClaimed = !tokenLower.includes('unclaimed');
    const ownerXVerified = !tokenLower.includes('owner_unverified');
    const isActive = !tokenLower.includes('deactivated');
    const isExpired = tokenLower.includes('expired');

    const tierC = tokenLower.includes('tierc');
    const tierB = tokenLower.includes('tierb');

    const karma = tierC ? 12 : tierB ? 35 : 140;
    const posts = tierC ? 2 : tierB ? 6 : 32;
    const comments = tierC ? 3 : tierB ? 7 : 36;
    // When token includes 'owner_alt', produce a different ownerXHandle for the same agentId
    const ownerXHandle = tokenLower.includes('owner_alt') ? `owner_alt_${agentId.slice(-6)}` : `owner_${agentId.slice(-8)}`;

    return {
      valid,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (isExpired ? -60 * 1000 : 60 * 60 * 1000)).toISOString(),
      agentId,
      agentName: `worker-${agentId.slice(-6)}`,
      karma,
      posts,
      comments,
      ownerXVerified,
      ownerXHandle,
      ownerRef: ownerXHandle,
      isClaimed,
      isActive
    };
  }
}
