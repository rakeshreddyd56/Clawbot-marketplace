/**
 * TASK-HARD-013: Redis caching layer for Moltbook verification snapshots.
 *
 * Security controls (per security-audit-moltbook-cache-2026-03-05.md):
 * - HMAC-signed cache values (HIGH-001: cache poisoning prevention)
 * - Zod validation on deserialization (MED-002: schema injection prevention)
 * - Max TTL cap (MED: TTL manipulation prevention)
 * - Cache stampede protection via SETNX lock (MED-004)
 * - NEVER stores raw identity tokens (HIGH-003)
 * - Graceful degradation when Redis is unavailable
 */

import { MoltbookVerificationSnapshotSchema, type MoltbookVerificationSnapshot } from '@claw/contracts';
import { signWithSecret, verifyWithSecret } from '@claw/utils';

/** Minimal Redis interface — compatible with ioredis or any Redis client */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<unknown>;
}

const CACHE_KEY_PREFIX = 'moltbook:snapshot:';
const LOCK_KEY_PREFIX = 'moltbook:lock:';
const DEFAULT_MAX_CACHE_TTL_SECONDS = 600; // 10 minutes hard cap
const LOCK_TTL_SECONDS = 10;
const STAMPEDE_RETRY_MS = 100;
const STAMPEDE_MAX_RETRIES = 3;

export type MoltbookCacheConfig = {
  redis: RedisClient;
  signingSecret: string; // CACHE_SIGNING_SECRET — must differ from SESSION_SECRET
  maxTtlSeconds?: number;
};

export class MoltbookSnapshotCache {
  private readonly redis: RedisClient;
  private readonly signingSecret: string;
  private readonly maxTtlSeconds: number;

  constructor(config: MoltbookCacheConfig) {
    if (!config.signingSecret || config.signingSecret.length < 32) {
      throw new Error(
        'CACHE_SIGNING_SECRET must be at least 32 characters. ' +
        'This is required for HMAC integrity protection of cached Moltbook snapshots.'
      );
    }
    this.redis = config.redis;
    this.signingSecret = config.signingSecret;
    this.maxTtlSeconds = config.maxTtlSeconds ?? DEFAULT_MAX_CACHE_TTL_SECONDS;
  }

  /**
   * Get a cached snapshot with HMAC integrity verification and Zod schema validation.
   * Returns null on cache miss, tampered data, or invalid schema.
   */
  async get(agentId: string): Promise<MoltbookVerificationSnapshot | null> {
    try {
      const raw = await this.redis.get(`${CACHE_KEY_PREFIX}${agentId}`);
      if (!raw) return null;

      // Split HMAC signature from payload (format: "{hmac}:{json}")
      const colonIdx = raw.indexOf(':');
      if (colonIdx === -1) {
        // Malformed cache entry — evict
        await this.invalidate(agentId);
        return null;
      }

      const sig = raw.slice(0, colonIdx);
      const payload = raw.slice(colonIdx + 1);

      // HIGH-001: Integrity check — prevents cache poisoning
      if (!verifyWithSecret(payload, sig, this.signingSecret)) {
        await this.invalidate(agentId); // Tampered — evict
        return null;
      }

      // MED-002: Zod validation — prevents deserialization injection
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        await this.invalidate(agentId);
        return null;
      }

      const result = MoltbookVerificationSnapshotSchema.safeParse(parsed);
      if (!result.success) {
        await this.invalidate(agentId); // Invalid schema — evict
        return null;
      }

      // Double-check expiry (belt-and-suspenders with Redis TTL)
      const now = Date.now();
      if (now >= new Date(result.data.expiresAt).getTime()) {
        await this.invalidate(agentId);
        return null;
      }

      return result.data;
    } catch {
      // Redis unavailable — graceful degradation (return cache miss)
      return null;
    }
  }

  /**
   * Cache a snapshot with HMAC signing and bounded TTL.
   * TTL = min(trustedUntilAt - now, maxTtlSeconds).
   */
  async set(agentId: string, snapshot: MoltbookVerificationSnapshot): Promise<void> {
    try {
      const ttl = this.computeTtl(snapshot.trustedUntilAt);
      if (ttl <= 0) return; // Already expired — don't cache

      const payload = JSON.stringify(snapshot);
      const sig = signWithSecret(payload, this.signingSecret);
      const cacheValue = `${sig}:${payload}`;

      await this.redis.set(
        `${CACHE_KEY_PREFIX}${agentId}`,
        cacheValue,
        'EX',
        ttl
      );
    } catch {
      // Redis unavailable — graceful degradation (skip caching)
    }
  }

  /**
   * Invalidate cache for an agent. Called by reverify() and webhook handlers.
   * SECURITY: Invalidation happens BEFORE API call (fail-open toward security).
   */
  async invalidate(agentId: string): Promise<void> {
    try {
      await this.redis.del(`${CACHE_KEY_PREFIX}${agentId}`);
    } catch {
      // Redis unavailable — graceful degradation
    }
  }

  /**
   * MED-004: Acquire a SETNX-based lock to prevent cache stampede.
   * Returns true if lock acquired, false if another request holds it.
   */
  async acquirePopulationLock(agentId: string): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `${LOCK_KEY_PREFIX}${agentId}`,
        '1',
        'NX',
        'EX',
        LOCK_TTL_SECONDS
      );
      // ioredis returns 'OK' on success, null on failure
      return result === 'OK' || result === 1;
    } catch {
      return true; // Redis down — let the request proceed
    }
  }

  /** Release the population lock after cache is populated. */
  async releasePopulationLock(agentId: string): Promise<void> {
    try {
      await this.redis.del(`${LOCK_KEY_PREFIX}${agentId}`);
    } catch {
      // Best-effort; lock has TTL anyway
    }
  }

  /**
   * Get snapshot with stampede protection. If lock is held by another request,
   * retries reading from cache a few times before returning null.
   */
  async getWithStampedeWait(agentId: string): Promise<MoltbookVerificationSnapshot | null> {
    const cached = await this.get(agentId);
    if (cached) return cached;

    // Check if another request is populating
    const lockAcquired = await this.acquirePopulationLock(agentId);
    if (lockAcquired) {
      // We hold the lock — caller should populate cache
      return null;
    }

    // Another request holds the lock — wait and retry from cache
    for (let i = 0; i < STAMPEDE_MAX_RETRIES; i++) {
      await new Promise((resolve) => setTimeout(resolve, STAMPEDE_RETRY_MS));
      const retried = await this.get(agentId);
      if (retried) return retried;
    }

    return null; // Give up — caller should fetch from API
  }

  private computeTtl(trustedUntilAt: string): number {
    const remainingMs = new Date(trustedUntilAt).getTime() - Date.now();
    const remainingSec = Math.floor(remainingMs / 1000);
    // Cap at maxTtlSeconds to prevent indefinite caching
    return Math.max(0, Math.min(remainingSec, this.maxTtlSeconds));
  }
}

/**
 * Create a MoltbookSnapshotCache from environment variables.
 * Returns null if REDIS_URL is not set (graceful degradation).
 */
export function createMoltbookCacheFromEnv(redis: RedisClient | null): MoltbookSnapshotCache | null {
  if (!redis) return null;

  const signingSecret = process.env.CACHE_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn(
      '[CACHE] CACHE_SIGNING_SECRET not set — Moltbook snapshot caching disabled. ' +
      'Set CACHE_SIGNING_SECRET (min 32 chars) to enable Redis caching.'
    );
    return null;
  }

  const maxTtl = parseInt(process.env.MOLTBOOK_CACHE_MAX_TTL_SECONDS ?? '', 10);

  return new MoltbookSnapshotCache({
    redis,
    signingSecret,
    maxTtlSeconds: isNaN(maxTtl) ? undefined : maxTtl
  });
}
