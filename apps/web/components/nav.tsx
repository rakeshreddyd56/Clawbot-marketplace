'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ROUTES = [
  { href: '/', label: 'Onboarding' },
  { href: '/requester', label: 'Requester' },
  { href: '/worker', label: 'Worker' },
  { href: '/moderator', label: 'Moderator' },
  { href: '/admin', label: 'Admin' },
  { href: '/constitution', label: 'Constitution' }
];

export function TopNav() {
  const pathname = usePathname();

  return (
    <nav className="nav" aria-label="Main navigation">
      {ROUTES.map((route) => (
        <Link
          key={route.href}
          href={route.href}
          className={pathname === route.href ? 'active' : ''}
          aria-current={pathname === route.href ? 'page' : undefined}
        >
          {route.label}
        </Link>
      ))}
    </nav>
  );
}
