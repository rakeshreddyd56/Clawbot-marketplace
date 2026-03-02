import type { AuthContext } from '../types/domain.js';
import { DomainError } from './errors.js';

export function parseAuthContext(headers: Record<string, unknown>): AuthContext {
  const actorAgentId = String(headers['x-agent-id'] ?? '');
  const role = String(headers['x-role'] ?? '');

  if (!actorAgentId || !role) {
    throw new DomainError('AUTH_REQUIRED', 'x-agent-id and x-role headers are required.', 401);
  }

  if (!['requester', 'worker', 'moderator', 'admin'].includes(role)) {
    throw new DomainError('AUTH_INVALID_ROLE', 'Invalid role.', 401);
  }

  return {
    actorAgentId,
    role: role as AuthContext['role']
  };
}
