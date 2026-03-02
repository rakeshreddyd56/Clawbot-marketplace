import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../types/domain.js';
import { DomainError } from './errors.js';

const SESSION_COOKIE = 'claw_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 8;

type SessionClaims = {
  sub: string;
  role: AuthContext['role'];
  ownerRef?: string;
  riskTier?: string;
  trustTier?: 'A' | 'B' | 'C';
  verifiedAt?: string;
  expiresAt?: string;
  scopes?: string[];
};

function secret(): string {
  return process.env.SESSION_SECRET ?? 'dev_claw_session_secret_change_me';
}

export function issueSessionToken(claims: SessionClaims, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  return jwt.sign(claims, secret(), {
    algorithm: 'HS256',
    expiresIn: ttlSeconds,
    issuer: 'clawbot-marketplace',
    audience: 'clawbot-clients'
  });
}

export function verifySessionToken(token: string): SessionClaims {
  try {
    return jwt.verify(token, secret(), {
      algorithms: ['HS256'],
      issuer: 'clawbot-marketplace',
      audience: 'clawbot-clients'
    }) as SessionClaims;
  } catch {
    throw new DomainError('AUTH_INVALID_TOKEN', 'Invalid session token.', 401);
  }
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: DEFAULT_TTL_SECONDS
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/'
  });
}

export function authFromRequest(request: FastifyRequest): AuthContext | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    const claims = verifySessionToken(token);

    return {
      actorAgentId: claims.sub,
      role: claims.role
    };
  }

  const cookieToken = request.cookies?.[SESSION_COOKIE];
  if (cookieToken) {
    const claims = verifySessionToken(cookieToken);
    return {
      actorAgentId: claims.sub,
      role: claims.role
    };
  }

  return null;
}
