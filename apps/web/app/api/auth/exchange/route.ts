import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';

  const response = await fetch(`${apiBase}/v1/sessions/exchange`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    return NextResponse.json(data, { status: response.status });
  }

  (await cookies()).set('bff_session', data.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8
  });

  return NextResponse.json({
    agentId: data.agentId,
    role: data.role,
    trustTier: data.trustTier,
    expiresAt: data.expiresAt
  });
}
