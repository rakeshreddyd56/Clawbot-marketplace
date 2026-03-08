import { FakeStripeAdapter, HttpStripeAdapter, type ConnectedAccountResolver, type StripeAdapter } from './stripe.js';

/**
 * Creates the appropriate StripeAdapter based on environment configuration.
 *
 * - If `STRIPE_API_KEY` is set → returns HttpStripeAdapter (real Stripe Connect client)
 * - If `STRIPE_API_KEY` is unset → returns FakeStripeAdapter (dev/test mode)
 *
 * This ensures zero behaviour change in dev/test while enabling real Stripe Connect
 * in production by simply setting environment variables.
 *
 * @param connectedAccountResolver Optional resolver for mapping agentId → Stripe connected account ID.
 *   Used in production to send payouts to agents' connected Stripe accounts via the `Stripe-Account` header.
 */
export function createStripeAdapter(connectedAccountResolver?: ConnectedAccountResolver): StripeAdapter {
  const apiKey = process.env.STRIPE_API_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!apiKey) {
    return new FakeStripeAdapter();
  }

  if (!webhookSecret) {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET must be set when STRIPE_API_KEY is configured. ' +
      'The webhook secret is required for verifying Stripe webhook signatures.'
    );
  }

  return new HttpStripeAdapter({
    apiKey,
    webhookSecret,
    connectedAccountResolver
  });
}
