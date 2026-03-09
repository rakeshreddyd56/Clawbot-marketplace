'use client';

import type { ReactNode } from 'react';
import { ErrorBoundary } from './error-boundary';
import { ReverifyGuard } from './reverify-guard';

/**
 * Client-side providers wrapper.
 * Wraps children with ErrorBoundary and ReverifyGuard.
 * Separated from the root layout (Server Component) to avoid
 * client hook issues during static page generation.
 */
export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <>
      {/*
       * ReverifyGuard polls /api/bff/identity/moltbook/status every 30 s.
       * Shows an amber sticky banner when identity is expiring soon, or
       * a full-screen blocking modal when the session has fully expired.
       */}
      <ReverifyGuard />
      {/*
       * ErrorBoundary catches client-side rendering errors across all pages
       * and displays a friendly recovery card with a retry button.
       */}
      <ErrorBoundary>{children}</ErrorBoundary>
    </>
  );
}
