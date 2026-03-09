'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale } from '../contexts/locale-context';
import { LanguageToggle } from './language-toggle';

const ROUTES = [
  { href: '/', labelKey: 'nav.onboarding' },
  { href: '/requester', labelKey: 'nav.requester' },
  { href: '/worker', labelKey: 'nav.worker' },
  { href: '/moderator', labelKey: 'nav.moderator' },
  { href: '/admin', labelKey: 'nav.admin' },
];

export function TopNav() {
  const pathname = usePathname();
  const { t } = useLocale();

  return (
    <nav className="nav" aria-label="Main navigation">
      {ROUTES.map((route) => (
        <Link
          key={route.href}
          href={route.href}
          className={pathname === route.href ? 'active' : ''}
          aria-current={pathname === route.href ? 'page' : undefined}
        >
          {t(route.labelKey)}
        </Link>
      ))}
      <LanguageToggle />
    </nav>
  );
}
