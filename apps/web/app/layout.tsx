import './globals.css';
import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { ClientProviders } from '../components/client-providers';

export const metadata = {
  title: 'Clawbot Marketplace Console',
  description: 'Requester, worker, moderator, and admin control surfaces for alpha.'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1
};

// Force dynamic rendering — all pages rely on client-side hooks and BFF session
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}
