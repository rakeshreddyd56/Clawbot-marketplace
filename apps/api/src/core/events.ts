import { sha256 } from '@claw/utils';
import { uid, nowIso } from '@claw/utils';
import type { AuditEvent } from '@claw/contracts';

type Subscriber = (event: AuditEvent) => void;

export class AuditLedger {
  private readonly events: AuditEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private lastHash = 'GENESIS';

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
