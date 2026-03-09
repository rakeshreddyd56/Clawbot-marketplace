import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../test-utils';
import { TopNav } from '../../components/nav';
import { LocaleProvider } from '../../contexts/locale-context';

// Mock next/navigation to control usePathname
vi.mock('next/navigation', () => ({
  usePathname: vi.fn().mockReturnValue('/')
}));

// Mock next/link to render as a plain anchor
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  )
}));

import { usePathname } from 'next/navigation';

function renderNav() {
  return render(
    <LocaleProvider>
      <TopNav />
    </LocaleProvider>
  );
}

describe('TopNav', () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue('/');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    Object.defineProperty(document, 'cookie', { writable: true, value: '' });
    document.documentElement.lang = 'en';
  });

  it('renders all five navigation links', () => {
    renderNav();
    expect(screen.getByRole('link', { name: 'Onboarding' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Requester' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Worker' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Moderator' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Admin' })).toBeInTheDocument();
  });

  it('renders correct href for each route', () => {
    renderNav();
    expect(screen.getByRole('link', { name: 'Onboarding' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Requester' })).toHaveAttribute('href', '/requester');
    expect(screen.getByRole('link', { name: 'Worker' })).toHaveAttribute('href', '/worker');
    expect(screen.getByRole('link', { name: 'Moderator' })).toHaveAttribute('href', '/moderator');
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
  });

  it('applies "active" class to the current route link on /', () => {
    vi.mocked(usePathname).mockReturnValue('/');
    renderNav();
    expect(screen.getByRole('link', { name: 'Onboarding' })).toHaveClass('active');
    expect(screen.getByRole('link', { name: 'Worker' })).not.toHaveClass('active');
    expect(screen.getByRole('link', { name: 'Admin' })).not.toHaveClass('active');
  });

  it('applies "active" class to /worker link when on /worker', () => {
    vi.mocked(usePathname).mockReturnValue('/worker');
    renderNav();
    expect(screen.getByRole('link', { name: 'Worker' })).toHaveClass('active');
    expect(screen.getByRole('link', { name: 'Onboarding' })).not.toHaveClass('active');
  });

  it('applies "active" class to /requester link when on /requester', () => {
    vi.mocked(usePathname).mockReturnValue('/requester');
    renderNav();
    expect(screen.getByRole('link', { name: 'Requester' })).toHaveClass('active');
    expect(screen.getByRole('link', { name: 'Worker' })).not.toHaveClass('active');
  });

  it('applies "active" class to /moderator link when on /moderator', () => {
    vi.mocked(usePathname).mockReturnValue('/moderator');
    renderNav();
    expect(screen.getByRole('link', { name: 'Moderator' })).toHaveClass('active');
  });

  it('applies "active" class to /admin link when on /admin', () => {
    vi.mocked(usePathname).mockReturnValue('/admin');
    renderNav();
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveClass('active');
  });

  it('only one link has the active class at a time', () => {
    vi.mocked(usePathname).mockReturnValue('/worker');
    renderNav();
    const activeLinks = screen.getAllByRole('link').filter((link) => link.classList.contains('active'));
    expect(activeLinks).toHaveLength(1);
  });

  it('renders within a nav element', () => {
    renderNav();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});
