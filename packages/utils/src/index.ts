import crypto from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(prefix = ''): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function signWithSecret(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyWithSecret(payload: string, signature: string, secret: string): boolean {
  const expected = signWithSecret(payload, secret);
  if (expected.length !== signature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
