import type { Store } from '../types/domain.js';
import { assertDomain } from '../core/errors.js';

export class PaymentWebhookService {
  constructor(private readonly store: Store) {}

  handleStripeEvent(payload: { type: string; data?: Record<string, unknown> }) {
    assertDomain(Boolean(payload.type), 'WEBHOOK_INVALID', 'Webhook payload missing event type.', 400);

    if (payload.type === 'charge.dispute.created') {
      return {
        accepted: true,
        action: 'hold_funds_and_raise_dispute_risk'
      };
    }

    if (payload.type === 'payout.failed') {
      return {
        accepted: true,
        action: 'mark_payout_pending_manual_review'
      };
    }

    if (payload.type === 'payment_intent.succeeded') {
      return {
        accepted: true,
        action: 'topup_confirmed'
      };
    }

    return {
      accepted: true,
      action: 'ignored'
    };
  }
}
