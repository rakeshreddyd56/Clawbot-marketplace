import crypto from 'node:crypto';

/**
 * Parsed Stripe webhook event after signature verification.
 */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created: number;
}

/**
 * Resolves an agentId to a Stripe connected account ID.
 * Used in production for Stripe Connect payouts.
 */
export type ConnectedAccountResolver = (agentId: string) => Promise<string | null | undefined>;

export interface StripeAdapter {
  createTopup(agentId: string, amount: number): Promise<{ topupId: string; status: 'succeeded' }>;
  createPayout(agentId: string, amount: number): Promise<{ payoutId: string; status: 'pending' | 'paid' }>;
  /**
   * Verifies a Stripe webhook signature and returns the parsed event.
   * Throws WebhookSignatureError if verification fails.
   *
   * @param rawBody - The raw request body as a Buffer or string (before JSON parsing)
   * @param signatureHeader - The `stripe-signature` header value
   * @returns Parsed StripeWebhookEvent
   */
  verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string): StripeWebhookEvent;
}

// ── Stripe signature verification constants ──────────────────────────────────
const STRIPE_SIGNATURE_SCHEME = 'v1';
const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes

/** Stripe API version pinned for consistency. */
const STRIPE_API_VERSION = '2024-12-18.acacia';

/** Default Stripe API base URL. */
const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com';

/** Maximum allowed webhook body size in bytes (64 KB). Prevents hash-DoS. */
export const WEBHOOK_MAX_BODY_BYTES = 65_536;

/**
 * Parses the `stripe-signature` header into timestamp and signatures.
 * Format: `t=timestamp,v1=signature1,v1=signature2,...`
 */
function parseStripeSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  const parts = header.split(',');
  let timestamp = -1;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't') {
      timestamp = Number.parseInt(value, 10);
    } else if (key === STRIPE_SIGNATURE_SCHEME) {
      signatures.push(value);
    }
  }

  return { timestamp, signatures };
}

/**
 * Computes the expected Stripe HMAC signature.
 * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256.
 */
function computeStripeSignature(timestamp: number, rawBody: string, secret: string): string {
  const signedPayload = `${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/**
 * Timing-safe comparison of two hex strings.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ── FakeStripeAdapter (dev/test mode) ────────────────────────────────────────

export class FakeStripeAdapter implements StripeAdapter {
  public readonly webhookSecret: string;

  constructor(webhookSecret?: string) {
    if (webhookSecret) {
      this.webhookSecret = webhookSecret;
    } else if (process.env.STRIPE_WEBHOOK_SECRET) {
      this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('STRIPE_WEBHOOK_SECRET must be set in production');
    } else {
      this.webhookSecret = 'whsec_test_secret';
    }
  }

  async createTopup(agentId: string, amount: number): Promise<{ topupId: string; status: 'succeeded' }> {
    return { topupId: `topup_${agentId}_${amount}`, status: 'succeeded' };
  }

  async createPayout(agentId: string, amount: number): Promise<{ payoutId: string; status: 'pending' | 'paid' }> {
    return { payoutId: `payout_${agentId}_${amount}`, status: 'pending' };
  }

  verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string): StripeWebhookEvent {
    return verifyStripeWebhookSignature(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
      signatureHeader,
      this.webhookSecret
    );
  }

  /**
   * Test helper: generates a valid stripe-signature header for a given payload.
   */
  static createTestSignature(rawBody: string, secret = 'whsec_test_secret', timestamp?: number): string {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const sig = computeStripeSignature(ts, rawBody, secret);
    return `t=${ts},v1=${sig}`;
  }
}

// ── StripeApiError ───────────────────────────────────────────────────────────

/**
 * Error type for Stripe API failures (4xx/5xx responses).
 * Includes the HTTP status code mapped to our domain:
 * - Stripe 4xx → statusCode 400 (client error in our domain)
 * - Stripe 5xx → statusCode 502 (bad gateway — upstream failure)
 */
export class StripeApiError extends Error {
  public readonly statusCode: number;
  public readonly stripeCode?: string;
  public readonly stripeType?: string;

  constructor(message: string, statusCode: number, stripeCode?: string, stripeType?: string) {
    super(message);
    this.name = 'StripeApiError';
    this.statusCode = statusCode;
    this.stripeCode = stripeCode;
    this.stripeType = stripeType;
  }
}

// ── HttpStripeAdapter (production mode) ──────────────────────────────────────

export interface HttpStripeAdapterConfig {
  apiKey: string;
  webhookSecret: string;
  connectedAccountResolver?: ConnectedAccountResolver;
  /** Override Stripe API base URL (useful for testing against mock servers). */
  apiBaseUrl?: string;
  /** Maximum number of retries on transient failures (5xx, 429). Default: 2 */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 250 */
  baseDelayMs?: number;
  /** Currency for payments. Default: 'usd' */
  currency?: string;
}

export class HttpStripeAdapter implements StripeAdapter {
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly connectedAccountResolver?: ConnectedAccountResolver;
  private readonly apiBaseUrl: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly currency: string;

  constructor(config: HttpStripeAdapterConfig) {
    this.apiKey = config.apiKey;
    this.webhookSecret = config.webhookSecret;
    this.connectedAccountResolver = config.connectedAccountResolver;
    // Strip trailing slashes from base URL
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_STRIPE_API_BASE).replace(/\/+$/, '');
    this.maxRetries = config.maxRetries ?? 2;
    this.baseDelayMs = config.baseDelayMs ?? 250;
    this.currency = config.currency ?? 'usd';
  }

  /**
   * Creates a PaymentIntent on Stripe for wallet top-up.
   * Amount is converted from dollars to cents. Auto-confirms the PaymentIntent.
   */
  async createTopup(agentId: string, amount: number): Promise<{ topupId: string; status: 'succeeded' }> {
    const amountCents = Math.round(amount * 100);
    const idempotencyKey = `stripe_idem_${crypto.randomUUID()}`;

    const params = new URLSearchParams();
    params.set('amount', String(amountCents));
    params.set('currency', this.currency);
    params.set('confirm', 'true');
    params.set('metadata[agent_id]', agentId);
    params.set('metadata[purpose]', 'wallet_topup');

    const response = await this.stripeRequest(
      'POST',
      '/v1/payment_intents',
      params.toString(),
      { idempotencyKey }
    );

    const status = response.status as string;
    if (status !== 'succeeded') {
      throw new StripeApiError(
        `PaymentIntent status is '${status}', expected 'succeeded'. PaymentIntent may require additional action (${status}).`,
        400,
        status
      );
    }

    return {
      topupId: response.id as string,
      status: 'succeeded'
    };
  }

  /**
   * Creates a Payout on Stripe Connect for agent withdrawal.
   * Amount is converted from dollars to cents.
   * If a connectedAccountResolver is configured, includes the Stripe-Account header.
   */
  async createPayout(agentId: string, amount: number): Promise<{ payoutId: string; status: 'pending' | 'paid' }> {
    const amountCents = Math.round(amount * 100);
    const idempotencyKey = `stripe_idem_${crypto.randomUUID()}`;

    // Resolve connected account for Stripe Connect
    const connectedAccountId = this.connectedAccountResolver
      ? await this.connectedAccountResolver(agentId)
      : undefined;

    const params = new URLSearchParams();
    params.set('amount', String(amountCents));
    params.set('currency', this.currency);
    params.set('metadata[agent_id]', agentId);
    params.set('metadata[purpose]', 'agent_payout');

    const response = await this.stripeRequest(
      'POST',
      '/v1/payouts',
      params.toString(),
      {
        idempotencyKey,
        stripeAccount: connectedAccountId ?? undefined
      }
    );

    // Map Stripe payout statuses to our domain
    const stripeStatus = response.status as string;
    const mappedStatus: 'pending' | 'paid' = stripeStatus === 'paid' ? 'paid' : 'pending';

    return {
      payoutId: response.id as string,
      status: mappedStatus
    };
  }

  verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string): StripeWebhookEvent {
    return verifyStripeWebhookSignature(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
      signatureHeader,
      this.webhookSecret
    );
  }

  // ── Private HTTP client ──────────────────────────────────────────────────

  /**
   * Makes an HTTP request to Stripe API with retry logic.
   * Retries on 5xx and 429 (rate limit) with exponential backoff.
   * Uses the same idempotency key across retries for safety.
   */
  private async stripeRequest(
    method: string,
    path: string,
    body: string,
    options: { idempotencyKey: string; stripeAccount?: string }
  ): Promise<Record<string, unknown>> {
    const url = `${this.apiBaseUrl}${path}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
      'Idempotency-Key': options.idempotencyKey
    };

    if (options.stripeAccount) {
      headers['Stripe-Account'] = options.stripeAccount;
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: baseDelay * 2^(attempt-1)
        const delay = this.baseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }

      try {
        const response = await fetch(url, {
          method,
          headers,
          body
        });

        const responseBody = await response.json() as Record<string, unknown>;

        // 429 Rate Limit — retry with backoff (respect Retry-After if present)
        if (response.status === 429 && attempt < this.maxRetries) {
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter) {
            const retryMs = Number.parseInt(retryAfter, 10) * 1000;
            if (retryMs > 0) {
              await sleep(retryMs);
            }
          }
          lastError = new StripeApiError(
            `Stripe rate limited (429)`,
            502
          );
          continue;
        }

        // 5xx Server Error — retry with backoff
        if (response.status >= 500 && attempt < this.maxRetries) {
          const errorObj = responseBody.error as Record<string, unknown> | undefined;
          lastError = new StripeApiError(
            `Stripe server error (${response.status}): ${errorObj?.message ?? 'Unknown error'}`,
            502
          );
          continue;
        }

        // 4xx Client Error — do not retry
        if (response.status >= 400 && response.status < 500) {
          const errorObj = responseBody.error as Record<string, unknown> | undefined;
          throw new StripeApiError(
            `Stripe API error: ${errorObj?.message ?? 'Unknown error'} (${errorObj?.code ?? response.status})`,
            400,
            errorObj?.code as string | undefined,
            errorObj?.type as string | undefined
          );
        }

        // 5xx on last attempt — throw
        if (response.status >= 500) {
          const errorObj = responseBody.error as Record<string, unknown> | undefined;
          throw new StripeApiError(
            `Stripe server error (${response.status}): ${errorObj?.message ?? 'Unknown error'}`,
            502
          );
        }

        return responseBody;
      } catch (err) {
        if (err instanceof StripeApiError) {
          throw err;
        }
        // Network error — retry
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt >= this.maxRetries) {
          throw new StripeApiError(
            `Stripe request failed after ${this.maxRetries + 1} attempts: ${lastError.message}`,
            502
          );
        }
      }
    }

    // Should not reach here, but just in case
    throw lastError ?? new StripeApiError('Stripe request failed', 502);
  }
}

// ── Shared verification logic ────────────────────────────────────────────────

/**
 * Verifies a Stripe webhook signature and returns the parsed event.
 *
 * Implements the same algorithm as `stripe.webhooks.constructEvent()`:
 * 1. Check body size (hash-DoS prevention)
 * 2. Parse the `stripe-signature` header for timestamp + v1 signatures
 * 3. Compute expected HMAC-SHA256 of `${timestamp}.${rawBody}`
 * 4. Compare each provided signature against expected (timing-safe)
 * 5. Check timestamp tolerance (default 5 minutes)
 * 6. Parse the JSON body and return the event
 *
 * @throws WebhookSignatureError with descriptive message on verification failure
 */
function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): StripeWebhookEvent {
  // Check body size before any crypto operations (hash-DoS prevention)
  if (Buffer.byteLength(rawBody, 'utf8') > WEBHOOK_MAX_BODY_BYTES) {
    throw new WebhookSignatureError(
      `Webhook body exceeds maximum allowed size of ${WEBHOOK_MAX_BODY_BYTES} bytes.`
    );
  }

  if (!signatureHeader) {
    throw new WebhookSignatureError('Missing stripe-signature header.');
  }

  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);

  if (timestamp < 0) {
    throw new WebhookSignatureError('Invalid stripe-signature header: missing timestamp.');
  }

  if (signatures.length === 0) {
    throw new WebhookSignatureError('Invalid stripe-signature header: no v1 signatures found.');
  }

  // Check timestamp tolerance to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError(
      `Webhook timestamp too old. Event timestamp: ${timestamp}, current: ${now}, tolerance: ${toleranceSeconds}s.`
    );
  }

  const expectedSignature = computeStripeSignature(timestamp, rawBody, webhookSecret);

  // Check if any of the provided signatures match
  const signatureMatch = signatures.some((sig) => timingSafeCompare(expectedSignature, sig));

  if (!signatureMatch) {
    throw new WebhookSignatureError('Webhook signature verification failed. No matching v1 signature.');
  }

  // Parse and validate the event body
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new WebhookSignatureError('Webhook body is not valid JSON.');
  }

  const event = parsed as Record<string, unknown>;
  if (!event.id || typeof event.id !== 'string') {
    throw new WebhookSignatureError('Webhook event failed validation: missing or empty "id" field.');
  }
  if (!event.type || typeof event.type !== 'string') {
    throw new WebhookSignatureError('Webhook event failed validation: missing or empty "type" field.');
  }

  return {
    id: event.id as string,
    type: event.type as string,
    data: (event.data as Record<string, unknown>) ?? {},
    created: typeof event.created === 'number' ? event.created : timestamp
  };
}

/**
 * Error type for webhook signature verification failures.
 * Used to distinguish from other errors and return 400 status.
 */
export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

/**
 * Builds a Stripe-compatible `stripe-signature` header value.
 * Useful in tests and adapters that need to construct valid webhook signatures.
 *
 * @param rawBody - The raw JSON body string
 * @param secret - The webhook secret (e.g. 'whsec_...')
 * @param timestamp - Optional Unix timestamp (defaults to now)
 * @returns A formatted `t=...,v1=...` signature header string
 */
export function buildStripeSignatureHeader(
  rawBody: string,
  secret: string,
  timestamp?: number
): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = computeStripeSignature(ts, rawBody, secret);
  return `t=${ts},v1=${sig}`;
}

// ── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
