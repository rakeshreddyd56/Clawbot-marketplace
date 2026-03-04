import './globals.css';
import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { ErrorBoundary } from '../components/error-boundary';
import { ReverifyGuard } from '../components/reverify-guard';

export const metadata = {
  title: 'Clawbot Marketplace Console',
  description: 'Requester, worker, moderator, and admin control surfaces for alpha.'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
         * ReverifyGuard polls /api/bff/identity/moltbook/status every 30 s.
         * Shows an amber sticky banner when identity is expiring soon, or
         * a full-screen blocking modal when the session has fully expired.
         */}
        <ReverifyGuard />
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {/*
         * ErrorBoundary catches client-side rendering errors across all pages
         * and displays a friendly recovery card with a retry button.
         */}
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
