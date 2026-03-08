import {
  MoltbookWebhookEventSchema,
  MoltbookTrustTierChangedPayloadSchema,
  MoltbookSuspendedPayloadSchema,
  MoltbookOwnerChangedPayloadSchema,
  MoltbookUnclaimedPayloadSchema,
  type MoltbookWebhookResult,
  type TrustTier
} from '@claw/contracts';
import { nowIso, uid, verifyWithSecret } from '@claw/utils';
import type { Store } from '../types/domain.js';
import type { AuditLedger } from '../core/events.js';
import type { MoltbookSnapshotCache } from '../adapters/moltbook-cache.js';
import { DomainError, assertDomain } from '../core/errors.js';

/**
 * TASK-HARD-014: Maximum number of processed Moltbook webhook event IDs
 * to retain in the in-memory replay protection set.
 * Prevents unbounded memory growth. Oldest entries evicted FIFO.
 * In production with Redis, this is handled by TTL-based expiry.
 */
const MAX_PROCESSED_EVENT_IDS = 10_000;

/**
 * TASK-HARD-014: Moltbook webhook processing service.
 *
 * Handles real-time trust tier changes, suspensions, owner changes,
 * and unclaimed events pushed by the Moltbook Identity API.
 *
 * Security controls:
 * - Moltbook-Signature header HMAC verification on all events
 * - Replay protection via bounded event ID set
 * - All events emit hash-chained audit trail entries
 */
export class MoltbookWebhookService {
  private readonly webhookSecret: string;
  private readonly cache: MoltbookSnapshotCache | null;

  constructor(
    private readonly store: Store,
    private readonly audit: AuditLedger,
    webhookSecret?: string,
    cache?: MoltbookSnapshotCache | null
  ) {
    this.webhookSecret = webhookSecret ?? process.env.MOLTBOOK_WEBHOOK_SECRET ?? 'moltbook-webhook-dev-secret';
    this.cache = cache ?? null;
  }

  /**
   * Verify the Moltbook-Signature header and process the webhook event.
   *
   * @param rawBody - The raw string body of the webhook request
   * @param signatureHeader - The Moltbook-Signature header value
   * @returns MoltbookWebhookResult describing what action was taken
   */
  async handleWebhook(rawBody: string, signatureHeader: string): Promise<MoltbookWebhookResult> {
    // Step 1: Verify HMAC signature
    this.verifySignature(rawBody, signatureHeader);

    // Step 2: Parse and validate the event payload
    const parsed = this.parseEvent(rawBody);

    // Step 3: Replay protection — check if we've already processed this event
    if (this.store.processedMoltbookWebhookEventIds.has(parsed.eventId)) {
      this.audit.publish('moltbook.webhook_duplicate', parsed.agentId, {
        eventId: parsed.eventId,
        eventType: parsed.eventType,
        duplicate: true
      });

      return {
        accepted: true,
        action: 'none',
        processed: false,
        duplicate: true,
        eventId: parsed.eventId
      };
    }

    // Step 4: Process the event based on type
    const result = await this.processEvent(parsed);

    // Step 5: Record event ID for replay protection (bounded)
    this.addProcessedEventId(parsed.eventId);

    return result;
  }

  /**
   * Verify the HMAC signature of the webhook request body.
   * Uses timing-safe comparison to prevent timing attacks.
   */
  private verifySignature(rawBody: string, signatureHeader: string): void {
    assertDomain(
      Boolean(signatureHeader) && signatureHeader.length > 0,
      'WEBHOOK_SIGNATURE_MISSING',
      'Moltbook-Signature header is required.',
      401
    );

    const isValid = verifyWithSecret(rawBody, signatureHeader, this.webhookSecret);

    if (!isValid) {
      this.audit.publish('moltbook.webhook_rejected', 'moltbook:webhook', {
        reason: 'Invalid webhook signature.',
        code: 'WEBHOOK_SIGNATURE_INVALID'
      });

      throw new DomainError(
        'WEBHOOK_SIGNATURE_INVALID',
        'Moltbook webhook signature verification failed.',
        401
      );
    }
  }

  /**
   * Parse and validate the raw webhook body against the event schema.
   */
  private parseEvent(rawBody: string) {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new DomainError('WEBHOOK_INVALID', 'Webhook body is not valid JSON.', 400);
    }

    const result = MoltbookWebhookEventSchema.safeParse(body);
    if (!result.success) {
      throw new DomainError(
        'WEBHOOK_INVALID',
        `Webhook payload did not match expected schema: ${result.error.message}`,
        400
      );
    }

    return result.data;
  }

  /**
   * Route the event to the appropriate handler based on eventType.
   */
  private async processEvent(event: {
    eventId: string;
    eventType: string;
    timestamp: string;
    agentId: string;
    payload: Record<string, unknown>;
  }): Promise<MoltbookWebhookResult> {
    switch (event.eventType) {
      case 'agent.trust_tier_changed':
        return this.handleTrustTierChanged(event);
      case 'agent.suspended':
        return this.handleAgentSuspended(event);
      case 'agent.owner_changed':
        return this.handleOwnerChanged(event);
      case 'agent.unclaimed':
        return this.handleAgentUnclaimed(event);
      default:
        // Unknown event type — accept but ignore
        this.audit.publish('moltbook.webhook_ignored', event.agentId, {
          eventId: event.eventId,
          eventType: event.eventType,
          reason: 'unknown_event_type'
        });
        return {
          accepted: true,
          action: 'ignored',
          processed: true,
          eventId: event.eventId
        };
    }
  }

  /**
   * Handle agent.trust_tier_changed — update the stored snapshot with new trust tier.
   * Recomputes trust tier from the new karma/posts/comments values.
   */
  private async handleTrustTierChanged(event: {
    eventId: string;
    eventType: string;
    agentId: string;
    payload: Record<string, unknown>;
  }): Promise<MoltbookWebhookResult> {
    const payloadResult = MoltbookTrustTierChangedPayloadSchema.safeParse(event.payload);
    assertDomain(payloadResult.success, 'WEBHOOK_INVALID', 'Invalid trust_tier_changed payload.', 400);
    const payload = payloadResult.data!;

    const snapshot = this.store.moltbookSnapshots.get(event.agentId);
    if (snapshot) {
      // TASK-HARD-013: Invalidate Redis cache BEFORE updating in-memory snapshot
      // to prevent stale cached data from being served
      if (this.cache) {
        await this.cache.invalidate(event.agentId);
      }

      // Update the snapshot with new trust tier data
      const updatedSnapshot = {
        ...snapshot,
        trustTier: payload.newTier,
        checkedAt: nowIso(),
        agent: {
          ...snapshot.agent,
          karma: payload.karma,
          stats: {
            posts: payload.posts,
            comments: payload.comments
          }
        }
      };

      // Recalculate block reasons based on new tier
      const blockReasons = snapshot.blockReasons.filter(
        (r) => r.code !== 'TRUST_TIER_LIMITED'
      );

      if (payload.newTier === 'C') {
        blockReasons.push({
          code: 'TRUST_TIER_LIMITED',
          message: 'Tier C allows onboarding and bidding but blocks reserve and payouts.',
          blocking: false
        });
      }

      updatedSnapshot.blockReasons = blockReasons;
      this.store.moltbookSnapshots.set(event.agentId, updatedSnapshot);

      // TASK-HARD-013: Re-cache the updated snapshot in Redis
      if (this.cache) {
        await this.cache.set(event.agentId, updatedSnapshot);
      }
    }

    this.audit.publish('moltbook.trust_tier_changed', event.agentId, {
      eventId: event.eventId,
      previousTier: payload.previousTier,
      newTier: payload.newTier,
      karma: payload.karma,
      posts: payload.posts,
      comments: payload.comments
    });

    return {
      accepted: true,
      action: 'trust_tier_updated',
      processed: true,
      eventId: event.eventId
    };
  }

  /**
   * Handle agent.suspended — apply immediate SUSPEND sanction.
   * Sets agent status to SUSPENDED and creates a sanction record.
   */
  private async handleAgentSuspended(event: {
    eventId: string;
    eventType: string;
    agentId: string;
    payload: Record<string, unknown>;
  }): Promise<MoltbookWebhookResult> {
    const payloadResult = MoltbookSuspendedPayloadSchema.safeParse(event.payload);
    assertDomain(payloadResult.success, 'WEBHOOK_INVALID', 'Invalid agent.suspended payload.', 400);
    const payload = payloadResult.data!;

    // TASK-HARD-013: Invalidate Redis cache immediately on suspension
    // Security-critical: stale cached snapshot could allow suspended agent to act
    if (this.cache) {
      await this.cache.invalidate(event.agentId);
    }

    // Create a sanction record for the suspension
    const sanctionId = uid('sanc');
    const sanction = {
      sanctionId,
      agentId: event.agentId,
      type: 'SUSPEND' as const,
      reasonCode: `moltbook_suspended: ${payload.reason}`,
      status: 'ACTIVE' as const,
      effectiveAt: payload.suspendedAt
    };

    const existingSanctions = this.store.sanctions.get(event.agentId) ?? [];
    existingSanctions.push(sanction);
    this.store.sanctions.set(event.agentId, existingSanctions);

    // Update agent status to SUSPENDED if agent exists in store
    const agentRecord = this.store.agents.get(event.agentId);
    if (agentRecord) {
      this.store.agents.set(event.agentId, {
        ...agentRecord,
        profile: { ...agentRecord.profile, status: 'SUSPENDED' }
      });
    }

    // Mark snapshot as hard-blocked
    const snapshot = this.store.moltbookSnapshots.get(event.agentId);
    if (snapshot) {
      const updatedSnapshot = {
        ...snapshot,
        hardBlocked: true,
        blockReasons: [
          ...snapshot.blockReasons,
          {
            code: 'SANCTIONED' as const,
            message: `Suspended by Moltbook: ${payload.reason}`,
            blocking: true
          }
        ]
      };
      this.store.moltbookSnapshots.set(event.agentId, updatedSnapshot);
      // Note: Do NOT re-cache suspended agents — force fresh verification on next request
    }

    this.audit.publish('moltbook.agent_suspended', event.agentId, {
      eventId: event.eventId,
      sanctionId,
      reason: payload.reason,
      suspendedAt: payload.suspendedAt
    });

    return {
      accepted: true,
      action: 'agent_suspended',
      processed: true,
      eventId: event.eventId
    };
  }

  /**
   * Handle agent.owner_changed — flag owner mismatch for moderation review.
   * Updates historical owner handle and snapshot.
   */
  private async handleOwnerChanged(event: {
    eventId: string;
    eventType: string;
    agentId: string;
    payload: Record<string, unknown>;
  }): Promise<MoltbookWebhookResult> {
    const payloadResult = MoltbookOwnerChangedPayloadSchema.safeParse(event.payload);
    assertDomain(payloadResult.success, 'WEBHOOK_INVALID', 'Invalid agent.owner_changed payload.', 400);
    const payload = payloadResult.data!;

    // TASK-HARD-013: Invalidate Redis cache on owner change
    // Security-critical: stale cached snapshot could allow old owner to act
    if (this.cache) {
      await this.cache.invalidate(event.agentId);
    }

    // Update snapshot with new owner handle
    const snapshot = this.store.moltbookSnapshots.get(event.agentId);
    if (snapshot) {
      const blockReasons = [...snapshot.blockReasons];

      // Add OWNER_MISMATCH if not already present
      if (!blockReasons.some((r) => r.code === 'OWNER_MISMATCH')) {
        blockReasons.push({
          code: 'OWNER_MISMATCH',
          message: 'Owner handle changed from historical record; payouts are frozen pending moderator review.',
          blocking: false
        });
      }

      this.store.moltbookSnapshots.set(event.agentId, {
        ...snapshot,
        agent: {
          ...snapshot.agent,
          owner: {
            ...snapshot.agent.owner,
            xHandle: payload.newOwnerHandle
          }
        },
        blockReasons
      });
    }

    // Persist owner mismatch flag for moderation review
    const flagId = uid('omf');
    this.store.ownerMismatchFlags.set(flagId, {
      flagId,
      agentId: event.agentId,
      previousHandle: payload.previousOwnerHandle,
      newHandle: payload.newOwnerHandle,
      detectedAt: nowIso()
    });

    // Update historical owner handle to the new one
    this.store.historicalOwnerHandles.set(event.agentId, payload.newOwnerHandle);

    this.audit.publish('moltbook.owner_changed', event.agentId, {
      eventId: event.eventId,
      previousOwnerHandle: payload.previousOwnerHandle,
      newOwnerHandle: payload.newOwnerHandle,
      flagId
    });

    return {
      accepted: true,
      action: 'owner_mismatch_flagged',
      processed: true,
      eventId: event.eventId
    };
  }

  /**
   * Handle agent.unclaimed — mark agent as hard-blocked.
   * Unclaimed bots cannot participate in the marketplace.
   */
  private async handleAgentUnclaimed(event: {
    eventId: string;
    eventType: string;
    agentId: string;
    payload: Record<string, unknown>;
  }): Promise<MoltbookWebhookResult> {
    const payloadResult = MoltbookUnclaimedPayloadSchema.safeParse(event.payload);
    assertDomain(payloadResult.success, 'WEBHOOK_INVALID', 'Invalid agent.unclaimed payload.', 400);
    const payload = payloadResult.data!;

    // TASK-HARD-013: Invalidate Redis cache on unclaimed event
    // Security-critical: stale cached snapshot could allow unclaimed bot to act
    if (this.cache) {
      await this.cache.invalidate(event.agentId);
    }

    // Mark snapshot as hard-blocked with BOT_NOT_CLAIMED
    const snapshot = this.store.moltbookSnapshots.get(event.agentId);
    if (snapshot) {
      const blockReasons = snapshot.blockReasons.filter(
        (r) => r.code !== 'BOT_NOT_CLAIMED'
      );
      blockReasons.push({
        code: 'BOT_NOT_CLAIMED',
        message: 'Moltbook bot is no longer owner-claimed.',
        blocking: true
      });

      this.store.moltbookSnapshots.set(event.agentId, {
        ...snapshot,
        valid: false,
        hardBlocked: true,
        agent: {
          ...snapshot.agent,
          isClaimed: false
        },
        blockReasons
      });
      // Note: Do NOT re-cache unclaimed agents — force fresh verification on next request
    }

    this.audit.publish('moltbook.agent_unclaimed', event.agentId, {
      eventId: event.eventId,
      unclaimedAt: payload.unclaimedAt
    });

    return {
      accepted: true,
      action: 'agent_unclaimed',
      processed: true,
      eventId: event.eventId
    };
  }

  /**
   * Add an event ID to the processed set with bounded eviction.
   * JavaScript Set preserves insertion order, so we can evict the oldest
   * entries (first in iteration order) when the set exceeds the limit.
   */
  private addProcessedEventId(eventId: string): void {
    const set = this.store.processedMoltbookWebhookEventIds;
    set.add(eventId);

    // Evict oldest entries if the set exceeds the maximum
    if (set.size > MAX_PROCESSED_EVENT_IDS) {
      const excess = set.size - MAX_PROCESSED_EVENT_IDS;
      let evicted = 0;
      for (const oldId of set) {
        if (evicted >= excess) break;
        set.delete(oldId);
        evicted++;
      }
    }
  }
}
