'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ROUTES = [
  { href: '/', label: 'Onboarding' },
  { href: '/requester', label: 'Requester' },
  { href: '/worker', label: 'Worker' },
  { href: '/moderator', label: 'Moderator' },
  { href: '/admin', label: 'Admin' }
];

export function TopNav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {ROUTES.map((route) => (
        <Link key={route.href} href={route.href} className={pathname === route.href ? 'active' : ''}>
          {route.label}
        </Link>
      ))}
    </nav>
  );
}
