import { z } from 'zod';
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

/**
 * TASK-HARD-001: Real HTTP client for the Moltbook Identity API.
 *
 * Calls POST /v1/identity/verify with Authorization: Bearer + X-Api-Key headers.
 * Uses Zod-validated responses, expiresAt from Moltbook exp claim,
 * and 3-retry exponential backoff on 500/429/network errors.
 */
const MoltbookApiResponseSchema = z.object({
  valid: z.boolean(),
  agentId: z.string().min(3),
  agentName: z.string().optional().default(''),
  checkedAt: z.string().optional(),
  karma: z.number().optional().default(0),
  posts: z.number().optional().default(0),
  comments: z.number().optional().default(0),
  ownerXVerified: z.boolean().optional().default(false),
  ownerXHandle: z.string().optional().default(''),
  ownerRef: z.string().optional().default(''),
  isClaimed: z.boolean().optional().default(true),
  isActive: z.boolean().optional().default(true),
  exp: z.union([z.number(), z.string()]).optional()
});

export class HttpMoltbookVerifier implements MoltbookVerifier {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly baseDelayMs: number;

  constructor(opts: {
    apiUrl: string;
    apiKey: string;
    requestTimeoutMs?: number;
    maxRetries?: number;
    baseDelayMs?: number;
  }) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
  }

  async verify(identityToken: string, audience: string): Promise<VerifiedIdentity> {
    if (!identityToken || !identityToken.startsWith('mbtok_')) {
      throw new DomainError('INVALID_IDENTITY_TOKEN', 'Identity token is invalid.', 401);
    }

    if (!audience || audience.length < 3) {
      throw new DomainError('AUDIENCE_REQUIRED', 'Audience is required and must be at least 3 characters.', 400);
    }

    let lastError: Error | null = null;
    let lastStatusCode: number | null = null;
    const totalAttempts = 1 + this.maxRetries; // initial + retries

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        // GAP-MED-001: AbortController with configurable timeout (default 10s)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        let response: Response;
        try {
          response = await fetch(`${this.apiUrl}/v1/identity/verify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${identityToken}`,
              'X-Api-Key': this.apiKey
            },
            body: JSON.stringify({ audience }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (response.status === 401) {
          const text = await response.text().catch(() => '');
          throw new DomainError(
            'INVALID_IDENTITY_TOKEN',
            `Moltbook identity verification failed: ${text}`,
            401
          );
        }

        if (response.status === 400) {
          const text = await response.text().catch(() => '');
          throw new DomainError(
            'MOLTBOOK_BAD_REQUEST',
            text || 'Moltbook identity verification failed',
            400
          );
        }

        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Moltbook returned ${response.status}`);
          lastStatusCode = response.status;
          if (attempt < totalAttempts - 1) {
            await this.backoff(attempt);
          }
          continue;
        }

        const json = await response.json();
        let parsed;
        try {
          parsed = MoltbookApiResponseSchema.parse(json);
        } catch (parseErr) {
          throw new DomainError(
            'MOLTBOOK_RESPONSE_INVALID',
            `Moltbook returned an invalid response: ${(parseErr as Error).message}`,
            502
          );
        }

        // Resolve expiresAt: if exp is a number treat as epoch seconds,
        // if string use directly, otherwise default to 1 hour from now
        let expiresAt: string;
        if (typeof parsed.exp === 'number') {
          expiresAt = new Date(parsed.exp * 1000).toISOString();
        } else if (typeof parsed.exp === 'string') {
          expiresAt = parsed.exp;
        } else {
          expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        }

        return {
          valid: parsed.valid,
          checkedAt: parsed.checkedAt ?? new Date().toISOString(),
          expiresAt,
          agentId: parsed.agentId,
          agentName: parsed.agentName,
          karma: parsed.karma,
          posts: parsed.posts,
          comments: parsed.comments,
          ownerXVerified: parsed.ownerXVerified,
          ownerXHandle: parsed.ownerXHandle,
          ownerRef: parsed.ownerRef,
          isClaimed: parsed.isClaimed,
          isActive: parsed.isActive
        };
      } catch (err) {
        if (err instanceof DomainError) throw err;
        lastError = err as Error;
        if (attempt < totalAttempts - 1) {
          await this.backoff(attempt);
        }
      }
    }

    // Distinguish between upstream HTTP errors and network/timeout errors
    if (lastStatusCode && lastStatusCode >= 500) {
      throw new DomainError(
        'MOLTBOOK_UPSTREAM_ERROR',
        `Moltbook identity API returned ${lastStatusCode} after ${totalAttempts} retries: ${lastError?.message}`,
        502
      );
    }

    throw new DomainError(
      'MOLTBOOK_UNAVAILABLE',
      `Moltbook identity API unavailable after ${totalAttempts} retries: ${lastError?.message}`,
      503
    );
  }

  private backoff(attempt: number): Promise<void> {
    const ms = Math.min(this.baseDelayMs * Math.pow(2, attempt), 8000);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
