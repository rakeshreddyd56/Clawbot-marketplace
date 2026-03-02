import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Clawbot Marketplace Console',
  description: 'Requester, worker, moderator, and admin control surfaces for alpha.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
