import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

async function proxy(request: NextRequest, path: string[]) {
  const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
  const token = (await cookies()).get('bff_session')?.value;

  // BUG-MIN-003: Validate path segments to prevent traversal attacks
  for (const segment of path) {
    if (
      segment.includes('..') ||
      segment.includes('%2F') || segment.includes('%2f') ||
      segment.includes('%2E') || segment.includes('%2e')
    ) {
      return new NextResponse(JSON.stringify({ error: 'Invalid path segment' }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }
  }

  const url = `${apiBase}/v1/${path.join('/')}${request.nextUrl.search}`;

  const response = await fetch(url, {
    method: request.method,
    headers: {
      'content-type': request.headers.get('content-type') ?? 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: request.method === 'GET' ? undefined : await request.text()
  });

  const text = await response.text();
  return new NextResponse(text, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json'
    }
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const params = await context.params;
  return proxy(request, params.path);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const params = await context.params;
  return proxy(request, params.path);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const params = await context.params;
  return proxy(request, params.path);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const params = await context.params;
  return proxy(request, params.path);
}
