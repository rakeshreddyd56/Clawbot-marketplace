/**
 * TASK-HARD-009: In-memory rate limiter for API routes.
 *
 * Uses a sliding-window counter approach with configurable limits per route group.
 * Protects:
 *   - Moltbook verify endpoints (external API cost)
 *   - Payout endpoints (financial abuse)
 *   - General API endpoints (DoS prevention)
 *
 * In production, replace with Redis-backed rate limiter for multi-instance support.
 */

import { DomainError } from './errors.js';

interface RateLimitEntry {
  /** Timestamps of requests in the current window (ms) */
  timestamps: number[];
}

export interface RateLimitConfig {
  /** Window size in milliseconds */
  windowMs: number;
  /** Maximum requests per window */
  maxRequests: number;
}

/** Scale factor for test environments (higher limits to prevent test flakiness) */
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
const testScale = isTestEnv ? 100 : 1;

/** Default rate limit configurations by route group */
export const RATE_LIMIT_CONFIGS = {
  /** Moltbook verify endpoints — protect external API costs (5 req/min/IP in prod) */
  moltbookVerify: { windowMs: 60_000, maxRequests: 5 * testScale },
  /** Payout endpoints — financial abuse prevention (3 req/min/agent in prod) */
  payout: { windowMs: 60_000, maxRequests: 3 * testScale },
  /** Webhook endpoints — Stripe/Moltbook webhooks (30 req/min/IP in prod) */
  webhook: { windowMs: 60_000, maxRequests: 30 * testScale },
  /** Task write endpoints — task creation/posting (20 req/min/agent in prod) */
  taskWrite: { windowMs: 60_000, maxRequests: 20 * testScale },
  /** General read endpoints — listing/search (120 req/min/IP in prod) */
  generalRead: { windowMs: 60_000, maxRequests: 120 * testScale },
  /** General write endpoints (60 req/min/agent in prod) */
  generalWrite: { windowMs: 60_000, maxRequests: 60 * testScale },
} as const;

export type RateLimitGroup = keyof typeof RATE_LIMIT_CONFIGS;

/**
 * In-memory rate limiter with sliding window counters.
 * Keys are typically IP addresses or agent IDs depending on the route group.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Map<string, RateLimitEntry>>();
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup every 60 seconds to evict stale entries
    this.cleanupIntervalId = setInterval(() => this.cleanup(), 60_000);
    // Allow the process to exit even if the interval is still running
    if (this.cleanupIntervalId?.unref) {
      this.cleanupIntervalId.unref();
    }
  }

  /**
   * Check if a request is allowed under the rate limit.
   * If allowed, records the request timestamp.
   * If denied, throws a 429 DomainError.
   *
   * @param group - The rate limit group (determines limits)
   * @param key - The rate limit key (IP, agentId, etc.)
   */
  check(group: RateLimitGroup, key: string): void {
    const config = RATE_LIMIT_CONFIGS[group];
    this.checkWithConfig(group, key, config);
  }

  /**
   * Check with a custom config (useful for testing or overrides).
   */
  checkWithConfig(group: string, key: string, config: RateLimitConfig): void {
    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Get or create group bucket
    if (!this.buckets.has(group)) {
      this.buckets.set(group, new Map());
    }
    const groupBucket = this.buckets.get(group)!;

    // Get or create entry for this key
    if (!groupBucket.has(key)) {
      groupBucket.set(key, { timestamps: [] });
    }
    const entry = groupBucket.get(key)!;

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);

    // Check limit
    if (entry.timestamps.length >= config.maxRequests) {
      const retryAfterMs = entry.timestamps[0] + config.windowMs - now;
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);
      throw new DomainError(
        'RATE_LIMITED',
        `Rate limit exceeded for ${group}. Try again in ${retryAfterSec} seconds.`,
        429
      );
    }

    // Record this request
    entry.timestamps.push(now);
  }

  /**
   * Get remaining requests for a key in a group.
   * When using a custom group name (e.g. 'global_override'), pass maxRequests explicitly.
   */
  remaining(group: string, key: string, maxRequests?: number): number {
    const config = RATE_LIMIT_CONFIGS[group as RateLimitGroup];
    const windowMs = config?.windowMs ?? 60_000;
    const max = maxRequests ?? config?.maxRequests ?? 100;
    const now = Date.now();
    const windowStart = now - windowMs;

    const groupBucket = this.buckets.get(group);
    if (!groupBucket) return max;

    const entry = groupBucket.get(key);
    if (!entry) return max;

    const activeCount = entry.timestamps.filter(ts => ts > windowStart).length;
    return Math.max(0, max - activeCount);
  }

  /**
   * Cleanup stale entries to prevent memory leaks.
   */
  private cleanup(): void {
    const now = Date.now();

    for (const [groupName, groupBucket] of this.buckets) {
      const config = RATE_LIMIT_CONFIGS[groupName as RateLimitGroup] ?? { windowMs: 60_000 };
      const windowStart = now - config.windowMs;

      for (const [key, entry] of groupBucket) {
        entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);
        if (entry.timestamps.length === 0) {
          groupBucket.delete(key);
        }
      }

      if (groupBucket.size === 0) {
        this.buckets.delete(groupName);
      }
    }
  }

  /**
   * Reset all rate limit buckets. Used in tests to prevent cross-test contamination.
   */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Shutdown the cleanup interval. Call this when the server stops.
   */
  shutdown(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }
}

/**
 * Extract the client IP from a Fastify request.
 * Uses x-forwarded-for if behind a reverse proxy, otherwise request.ip.
 */
export function getClientIp(request: { ip: string; headers: Record<string, string | string[] | undefined> }): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return request.ip;
}
