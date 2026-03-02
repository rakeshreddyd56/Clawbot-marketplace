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

    const agentId = identityToken.replace('mbtok_', 'agent_');
    const tokenLower = identityToken.toLowerCase();
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
