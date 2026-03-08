import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type { MoltbookVerificationSnapshot } from '@claw/contracts';
import { signWithSecret } from '@claw/utils';
import { MoltbookSnapshotCache, type RedisClient } from '../src/adapters/moltbook-cache.js';

/**
 * TASK-HARD-013: Tests for Moltbook Redis caching layer.
 *
 * Covers: cache hit, cache miss, invalidation, HMAC integrity,
 * Zod schema validation, TTL computation, stampede protection,
 * graceful degradation when Redis is unavailable.
 */

function makeSnapshot(overrides: Partial<MoltbookVerificationSnapshot> = {}): MoltbookVerificationSnapshot {
  const now = Date.now();
  return {
    valid: true,
    checkedAt: new Date(now).toISOString(),
    trustedUntilAt: new Date(now + 50 * 60 * 1000).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    trustTier: 'A',
    hardBlocked: false,
    blockReasons: [],
    agent: {
      id: 'agent_test1',
      name: 'worker-test1',
      karma: 140,
      isClaimed: true,
      stats: { posts: 32, comments: 36 },
      owner: { xVerified: true, xHandle: 'owner_test1' }
    },
    ...overrides
  };
}

/** In-memory mock Redis for unit testing */
function createMockRedis(): RedisClient & {
  store: Map<string, { value: string; expiresAtMs?: number }>;
  failNextCall: boolean;
} {
  const store = new Map<string, { value: string; expiresAtMs?: number }>();
  const mock = {
    store,
    failNextCall: false,
    async get(key: string): Promise<string | null> {
      if (mock.failNextCall) {
        mock.failNextCall = false;
        throw new Error('Redis connection refused');
      }
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs && Date.now() > entry.expiresAtMs) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, ...args: Array<string | number>): Promise<unknown> {
      if (mock.failNextCall) {
        mock.failNextCall = false;
        throw new Error('Redis connection refused');
      }
      // Parse EX and NX args
      let expiresAtMs: number | undefined;
      let nx = false;
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'EX' && i + 1 < args.length) {
          expiresAtMs = Date.now() + Number(args[i + 1]) * 1000;
          i++;
        }
        if (String(args[i]).toUpperCase() === 'NX') {
          nx = true;
        }
      }
      if (nx && store.has(key)) {
        return null; // Key exists, NX fails
      }
      store.set(key, { value, expiresAtMs });
      return 'OK';
    },
    async del(...keys: string[]): Promise<number> {
      if (mock.failNextCall) {
        mock.failNextCall = false;
        throw new Error('Redis connection refused');
      }
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
    async quit(): Promise<unknown> {
      return 'OK';
    }
  };
  return mock;
}

const SIGNING_SECRET = 'test-secret-key-that-is-at-least-32-chars-long!!';

describe('MoltbookSnapshotCache', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let cache: MoltbookSnapshotCache;

  beforeEach(() => {
    redis = createMockRedis();
    cache = new MoltbookSnapshotCache({
      redis,
      signingSecret: SIGNING_SECRET,
      maxTtlSeconds: 600
    });
  });

  // --- Constructor validation ---

  it('rejects signing secret shorter than 32 characters', () => {
    expect(
      () => new MoltbookSnapshotCache({ redis, signingSecret: 'short' })
    ).toThrow('CACHE_SIGNING_SECRET must be at least 32 characters');
  });

  // --- Cache miss ---

  it('returns null on cache miss', async () => {
    const result = await cache.get('agent_nonexistent');
    expect(result).toBeNull();
  });

  // --- Cache hit ---

  it('returns cached snapshot on cache hit with valid HMAC', async () => {
    const snapshot = makeSnapshot();
    await cache.set('agent_test1', snapshot);

    const result = await cache.get('agent_test1');
    expect(result).not.toBeNull();
    expect(result!.agent.id).toBe('agent_test1');
    expect(result!.trustTier).toBe('A');
    expect(result!.valid).toBe(true);
  });

  // --- Cache invalidation ---

  it('invalidates cache and returns null on subsequent get', async () => {
    const snapshot = makeSnapshot();
    await cache.set('agent_test1', snapshot);

    // Confirm cached
    expect(await cache.get('agent_test1')).not.toBeNull();

    // Invalidate
    await cache.invalidate('agent_test1');

    // Confirm evicted
    expect(await cache.get('agent_test1')).toBeNull();
  });

  // --- HMAC integrity (HIGH-001) ---

  it('rejects tampered cache entries (HMAC mismatch)', async () => {
    const snapshot = makeSnapshot();
    const payload = JSON.stringify(snapshot);
    // Store with wrong HMAC
    const wrongSig = signWithSecret(payload, 'wrong-secret-that-is-definitely-not-the-real-one');
    redis.store.set('moltbook:snapshot:agent_test1', {
      value: `${wrongSig}:${payload}`
    });

    const result = await cache.get('agent_test1');
    expect(result).toBeNull();
    // Tampered entry should be evicted
    expect(redis.store.has('moltbook:snapshot:agent_test1')).toBe(false);
  });

  it('rejects malformed cache entries (no colon separator)', async () => {
    redis.store.set('moltbook:snapshot:agent_test1', {
      value: 'nocolonseparator'
    });

    const result = await cache.get('agent_test1');
    expect(result).toBeNull();
    expect(redis.store.has('moltbook:snapshot:agent_test1')).toBe(false);
  });

  // --- Zod schema validation (MED-002) ---

  it('rejects cached entries with invalid schema', async () => {
    const invalidPayload = JSON.stringify({ valid: 'not-a-boolean', junk: true });
    const sig = signWithSecret(invalidPayload, SIGNING_SECRET);
    redis.store.set('moltbook:snapshot:agent_test1', {
      value: `${sig}:${invalidPayload}`
    });

    const result = await cache.get('agent_test1');
    expect(result).toBeNull();
    expect(redis.store.has('moltbook:snapshot:agent_test1')).toBe(false);
  });

  it('rejects cached entries with invalid JSON', async () => {
    const badJson = '{not-valid-json';
    const sig = signWithSecret(badJson, SIGNING_SECRET);
    redis.store.set('moltbook:snapshot:agent_test1', {
      value: `${sig}:${badJson}`
    });

    const result = await cache.get('agent_test1');
    expect(result).toBeNull();
  });

  // --- Expiry check (belt-and-suspenders) ---

  it('rejects expired snapshots even if Redis TTL has not fired', async () => {
    const expired = makeSnapshot({
      expiresAt: new Date(Date.now() - 60_000).toISOString() // expired 1 minute ago
    });

    // Force-store with valid HMAC (bypassing TTL check in set)
    const payload = JSON.stringify(expired);
    const sig = signWithSecret(payload, SIGNING_SECRET);
    redis.store.set('moltbook:snapshot:agent_test1', {
      value: `${sig}:${payload}`
    });

    const result = await cache.get('agent_test1');
    expect(result).toBeNull();
  });

  // --- TTL computation ---

  it('does not cache already-expired snapshots', async () => {
    const expired = makeSnapshot({
      trustedUntilAt: new Date(Date.now() - 60_000).toISOString()
    });

    await cache.set('agent_test1', expired);
    // Should not have been stored (TTL <= 0)
    expect(redis.store.has('moltbook:snapshot:agent_test1')).toBe(false);
  });

  it('caps TTL at maxTtlSeconds', async () => {
    const farFuture = makeSnapshot({
      trustedUntilAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
    });

    // Spy on redis.set to check TTL arg
    const setSpy = vi.spyOn(redis, 'set');
    await cache.set('agent_test1', farFuture);

    expect(setSpy).toHaveBeenCalledWith(
      'moltbook:snapshot:agent_test1',
      expect.any(String),
      'EX',
      600 // maxTtlSeconds cap
    );
  });

  // --- Graceful degradation ---

  it('returns null on Redis failure (get)', async () => {
    redis.failNextCall = true;
    const result = await cache.get('agent_test1');
    expect(result).toBeNull();
  });

  it('silently skips caching on Redis failure (set)', async () => {
    redis.failNextCall = true;
    // Should not throw
    await expect(cache.set('agent_test1', makeSnapshot())).resolves.not.toThrow();
  });

  it('silently skips invalidation on Redis failure (invalidate)', async () => {
    redis.failNextCall = true;
    await expect(cache.invalidate('agent_test1')).resolves.not.toThrow();
  });

  // --- Stampede protection (MED-004) ---

  it('acquires population lock when no lock exists', async () => {
    const acquired = await cache.acquirePopulationLock('agent_test1');
    expect(acquired).toBe(true);
  });

  it('fails to acquire population lock when already held', async () => {
    await cache.acquirePopulationLock('agent_test1');
    const secondAttempt = await cache.acquirePopulationLock('agent_test1');
    expect(secondAttempt).toBe(false);
  });

  it('releases population lock', async () => {
    await cache.acquirePopulationLock('agent_test1');
    await cache.releasePopulationLock('agent_test1');

    // Lock should be released now
    const acquired = await cache.acquirePopulationLock('agent_test1');
    expect(acquired).toBe(true);
  });

  it('returns lock acquired=true when Redis is down (fail-open)', async () => {
    redis.failNextCall = true;
    const acquired = await cache.acquirePopulationLock('agent_test1');
    expect(acquired).toBe(true); // Fail-open: let request proceed
  });

  // --- getWithStampedeWait ---

  it('returns cached value immediately on cache hit (no stampede)', async () => {
    const snapshot = makeSnapshot();
    await cache.set('agent_test1', snapshot);

    const result = await cache.getWithStampedeWait('agent_test1');
    expect(result).not.toBeNull();
    expect(result!.agent.id).toBe('agent_test1');
  });

  it('returns null and acquires lock on cache miss (caller populates)', async () => {
    const result = await cache.getWithStampedeWait('agent_test1');
    expect(result).toBeNull();
    // Lock should have been acquired by getWithStampedeWait
    expect(redis.store.has('moltbook:lock:agent_test1')).toBe(true);
  });

  // --- Round-trip with different trust tiers ---

  it('correctly round-trips Tier B snapshot through cache', async () => {
    const tierB = makeSnapshot({
      trustTier: 'B',
      agent: {
        id: 'agent_tierb',
        name: 'worker-tierb',
        karma: 35,
        isClaimed: true,
        stats: { posts: 6, comments: 7 },
        owner: { xVerified: true, xHandle: 'owner_tierb' }
      }
    });

    await cache.set('agent_tierb', tierB);
    const result = await cache.get('agent_tierb');
    expect(result).not.toBeNull();
    expect(result!.trustTier).toBe('B');
    expect(result!.agent.karma).toBe(35);
  });

  it('correctly round-trips Tier C snapshot with block reasons', async () => {
    const tierC = makeSnapshot({
      trustTier: 'C',
      blockReasons: [
        {
          code: 'TRUST_TIER_LIMITED',
          message: 'Tier C allows onboarding and bidding but blocks reserve and payouts.',
          blocking: false
        }
      ],
      agent: {
        id: 'agent_tierc',
        name: 'worker-tierc',
        karma: 12,
        isClaimed: true,
        stats: { posts: 2, comments: 3 },
        owner: { xVerified: true, xHandle: 'owner_tierc' }
      }
    });

    await cache.set('agent_tierc', tierC);
    const result = await cache.get('agent_tierc');
    expect(result).not.toBeNull();
    expect(result!.trustTier).toBe('C');
    expect(result!.blockReasons).toHaveLength(1);
    expect(result!.blockReasons[0].code).toBe('TRUST_TIER_LIMITED');
  });
});
