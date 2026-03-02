'use client';

export type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

function joinPath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

export async function bffFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/bff/${joinPath(path)}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    },
    cache: 'no-store'
  });

  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as T | ApiErrorPayload) : ({} as T);

  if (!response.ok) {
    const errorPayload = payload as ApiErrorPayload;
    const message = errorPayload.error?.message ?? `Request failed with status ${response.status}`;
    const code = errorPayload.error?.code ?? 'API_ERROR';
    throw new Error(`${code}: ${message}`);
  }

  return payload as T;
}
