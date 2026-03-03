import crypto from 'node:crypto';
import type { AuthContext } from '../types/domain.js';
import { DomainError } from './errors.js';

/**
 * Header-based auth modes:
 *   HEADER_AUTH_ENABLED unset  → dev/test mode, unsigned headers allowed
 *   HEADER_AUTH_ENABLED=false  → production default, header auth disabled (401)
 *   HEADER_AUTH_ENABLED=true   → HMAC-signed headers required (replay-protected)
 *
 * When enabled, callers must include:
 *   x-agent-id: <agentId>
 *   x-role:     <role>
 *   x-timestamp: <unix-epoch-ms>
 *   x-signature: HMAC-SHA256(<agentId>:<role>:<timestamp>, HEADER_AUTH_SECRET)
 *
 * The timestamp must be within 30 seconds of server time.
 */
export function parseAuthContext(headers: Record<string, unknown>): AuthContext {
  const enabled = process.env.HEADER_AUTH_ENABLED;

  // Production: HEADER_AUTH_ENABLED=false → deny all header auth
  if (enabled === 'false') {
    throw new DomainError('HEADER_AUTH_DISABLED', 'Header-based auth is disabled. Use session JWT.', 401);
  }

  const actorAgentId = String(headers['x-agent-id'] ?? '');
  const role = String(headers['x-role'] ?? '');

  if (!actorAgentId || !role) {
    throw new DomainError('AUTH_REQUIRED', 'x-agent-id and x-role headers are required.', 401);
  }

  if (!['requester', 'worker', 'moderator', 'admin'].includes(role)) {
    throw new DomainError('AUTH_INVALID_ROLE', 'Invalid role.', 401);
  }

  // Production: HEADER_AUTH_ENABLED=true → HMAC signature required
  if (enabled === 'true') {
    const secret = process.env.HEADER_AUTH_SECRET;
    if (!secret) {
      throw new DomainError('HEADER_AUTH_MISCONFIGURED', 'HEADER_AUTH_SECRET is not configured.', 500);
    }

    const timestamp = String(headers['x-timestamp'] ?? '');
    const signature = String(headers['x-signature'] ?? '');

    if (!timestamp || !signature) {
      throw new DomainError('AUTH_SIGNATURE_REQUIRED', 'x-timestamp and x-signature headers are required.', 401);
    }

    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      throw new DomainError('AUTH_TIMESTAMP_INVALID', 'x-timestamp must be a numeric epoch ms.', 401);
    }

    // Replay protection: reject timestamps outside 30-second window
    const ageSec = (Date.now() - ts) / 1000;
    if (Math.abs(ageSec) > 30) {
      throw new DomainError('AUTH_TIMESTAMP_EXPIRED', 'Request timestamp is outside 30-second window.', 401);
    }

    const payload = `${actorAgentId}:${role}:${timestamp}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const provided = Buffer.from(signature, 'hex');

    // Guard against non-hex or wrong-length signatures
    if (provided.length !== 32 || expected.length !== signature.length) {
      throw new DomainError('AUTH_SIGNATURE_INVALID', 'x-signature is invalid.', 401);
    }

    const expectedBuf = Buffer.from(expected, 'hex');
    const valid = crypto.timingSafeEqual(expectedBuf, provided);
    if (!valid) {
      throw new DomainError('AUTH_SIGNATURE_INVALID', 'x-signature is invalid.', 401);
    }
  }

  // Dev/test mode (HEADER_AUTH_ENABLED unset): allow unsigned headers
  return {
    actorAgentId,
    role: role as AuthContext['role']
  };
}

/**
 * Generate a valid HMAC-signed auth header set for testing or internal callers.
 * Requires HEADER_AUTH_ENABLED=true and HEADER_AUTH_SECRET to be set.
 */
export function signAuthHeaders(agentId: string, role: AuthContext['role']): Record<string, string> {
  const secret = process.env.HEADER_AUTH_SECRET ?? 'dev_header_secret';
  const timestamp = String(Date.now());
  const payload = `${agentId}:${role}:${timestamp}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return {
    'x-agent-id': agentId,
    'x-role': role,
    'x-timestamp': timestamp,
    'x-signature': signature
  };
}
