import { sha256 } from '@claw/utils';
import { uid, nowIso } from '@claw/utils';
import type { AuditEvent } from '@claw/contracts';

type Subscriber = (event: AuditEvent) => void;

/**
 * Optional persistence callbacks for AuditLedger.
 * When provided, events are written through to PostgreSQL asynchronously.
 */
export interface AuditPersistence {
  /** Write a single event to the audit_events table (fire-and-forget). */
  writeEvent: (event: AuditEvent) => Promise<void>;
}

export class AuditLedger {
  private readonly events: AuditEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private lastHash = 'GENESIS';
  private readonly persistence?: AuditPersistence;

  /**
   * @param options.persistence — Optional PG write-through callbacks.
   *   When provided, each published event is persisted to the audit_events table.
   * @param options.preloadedEvents — Events loaded from PG on startup.
   *   Restores the in-memory chain so new events continue the hash chain.
   */
  constructor(options?: { persistence?: AuditPersistence; preloadedEvents?: AuditEvent[] }) {
    this.persistence = options?.persistence;

    if (options?.preloadedEvents && options.preloadedEvents.length > 0) {
      this.events.push(...options.preloadedEvents);
      // Resume the hash chain from the last persisted event
      const last = options.preloadedEvents[options.preloadedEvents.length - 1];
      this.lastHash = last.hash;
    }
  }

  publish(eventType: string, entityId: string, payload: Record<string, unknown>): AuditEvent {
    const base = {
      eventId: uid('evt'),
      eventType,
      entityId,
      payload,
      timestamp: nowIso(),
      previousHash: this.lastHash
    };

    const hash = sha256(JSON.stringify(base));
    const event: AuditEvent = { ...base, hash };
    this.lastHash = hash;
    this.events.push(event);

    // Write-through to PostgreSQL (fire-and-forget)
    if (this.persistence) {
      this.persistence.writeEvent(event).catch((err) => {
        console.error('[AuditLedger] Write-through error:', err);
      });
    }

    for (const sub of this.subscribers) {
      sub(event);
    }

    return event;
  }

  getByEntity(entityId: string): AuditEvent[] {
    return this.events.filter((evt) => evt.entityId === entityId);
  }

  getAll(): AuditEvent[] {
    return [...this.events];
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * TASK-FEAT-006: Verify the integrity of the entire audit hash chain.
   * Re-computes each event's hash and validates previousHash linkage.
   */
  verifyChain(): { valid: boolean; totalEvents: number; firstBreakAt?: string; breakReason?: string } {
    const events = this.events;
    const totalEvents = events.length;

    if (totalEvents === 0) {
      return { valid: true, totalEvents };
    }

    let expectedPrevious = 'GENESIS';

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];

      // Verify previousHash linkage
      if (evt.previousHash !== expectedPrevious) {
        return {
          valid: false,
          totalEvents,
          firstBreakAt: evt.eventId,
          breakReason: `previousHash mismatch at event ${i}: expected '${expectedPrevious}', got '${evt.previousHash}'`
        };
      }

      // Re-compute hash from the base fields (same construction as publish())
      const base = {
        eventId: evt.eventId,
        eventType: evt.eventType,
        entityId: evt.entityId,
        payload: evt.payload,
        timestamp: evt.timestamp,
        previousHash: evt.previousHash
      };
      const recomputed = sha256(JSON.stringify(base));

      if (recomputed !== evt.hash) {
        return {
          valid: false,
          totalEvents,
          firstBreakAt: evt.eventId,
          breakReason: `hash mismatch at event ${i}: stored hash does not match recomputed hash`
        };
      }

      expectedPrevious = evt.hash;
    }

    return { valid: true, totalEvents };
  }
}
