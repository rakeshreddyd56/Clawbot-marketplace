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
}
