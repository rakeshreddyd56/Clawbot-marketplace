import type { StripeWebhookEvent } from '../adapters/stripe.js';
import { assertDomain } from '../core/errors.js';
import type { Store } from '../types/domain.js';

export type WebhookProcessingResult = {
  accepted: boolean;
  action: string;
  eventId: string;
  eventType: string;
  duplicate?: boolean;
};

export class PaymentWebhookService {
  constructor(private readonly store: Store) {}

  /**
   * Processes a verified Stripe webhook event with idempotency.
   *
   * - If the event ID has already been processed, returns { duplicate: true } immediately.
   * - Otherwise processes the event, records its ID, and returns the result.
   *
   * @param event - A verified StripeWebhookEvent (already signature-checked)
   * @returns Processing result with action taken
   */
  handleStripeEvent(event: StripeWebhookEvent): WebhookProcessingResult {
    assertDomain(Boolean(event.type), 'WEBHOOK_INVALID', 'Webhook payload missing event type.', 400);
    assertDomain(Boolean(event.id), 'WEBHOOK_INVALID', 'Webhook payload missing event ID.', 400);

    // ── Idempotency check: reject duplicate events ──────────────────────
    if (this.store.processedWebhookEventIds.has(event.id)) {
      return {
        accepted: true,
        action: 'skipped',
        eventId: event.id,
        eventType: event.type,
        duplicate: true
      };
    }

    // ── Process the event based on type ─────────────────────────────────
    let action: string;

    if (event.type === 'charge.dispute.created') {
      action = 'hold_funds_and_raise_dispute_risk';
    } else if (event.type === 'payout.failed') {
      action = 'mark_payout_pending_manual_review';
    } else if (event.type === 'payment_intent.succeeded') {
      action = 'topup_confirmed';
    } else {
      action = 'ignored';
    }

    // ── Record event ID for idempotency ─────────────────────────────────
    this.store.processedWebhookEventIds.add(event.id);

    return {
      accepted: true,
      action,
      eventId: event.id,
      eventType: event.type
    };
  }
}
