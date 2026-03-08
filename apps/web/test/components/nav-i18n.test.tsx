import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopNav } from '../../components/nav';
import { LocaleProvider } from '../../contexts/locale-context';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: vi.fn().mockReturnValue('/'),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  ),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderNav() {
  return render(
    <LocaleProvider>
      <TopNav />
    </LocaleProvider>
  );
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('TopNav i18n integration', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: '',
    });
    document.documentElement.lang = 'en';
  });

  // ─── English Labels ───────────────────────────────────────────────────

  describe('English locale (default)', () => {
    it('renders nav links with English labels', () => {
      renderNav();
      expect(screen.getByText('Onboarding')).toBeInTheDocument();
      expect(screen.getByText('Requester')).toBeInTheDocument();
      expect(screen.getByText('Worker')).toBeInTheDocument();
      expect(screen.getByText('Moderator')).toBeInTheDocument();
      expect(screen.getByText('Admin')).toBeInTheDocument();
    });

    it('renders LanguageToggle in the nav', () => {
      renderNav();
      expect(screen.getByTestId('language-toggle')).toBeInTheDocument();
    });

    it('LanguageToggle shows EN as active', () => {
      renderNav();
      expect(screen.getByText('EN')).toHaveClass('language-toggle-active');
    });
  });

  // ─── Hindi Labels After Toggle ────────────────────────────────────────

  describe('Hindi locale (after toggle)', () => {
    it('switches nav labels to Hindi when language is toggled', async () => {
      renderNav();

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      // Hindi nav labels from hi.json
      expect(screen.getByText('ऑनबोर्डिंग')).toBeInTheDocument();
      expect(screen.getByText('अनुरोधकर्ता')).toBeInTheDocument();
      expect(screen.getByText('कार्यकर्ता')).toBeInTheDocument();
      expect(screen.getByText('मॉडरेटर')).toBeInTheDocument();
      expect(screen.getByText('प्रशासक')).toBeInTheDocument();
    });

    it('English labels are no longer visible after toggling to Hindi', async () => {
      renderNav();

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(screen.queryByText('Onboarding')).not.toBeInTheDocument();
      expect(screen.queryByText('Requester')).not.toBeInTheDocument();
      expect(screen.queryByText('Worker')).not.toBeInTheDocument();
      // Note: "Moderator" would also not appear (Hindi is "मॉडरेटर")
      expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    });

    it('LanguageToggle shows हिन्दी as active after toggle', async () => {
      renderNav();

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(screen.getByText('हिन्दी')).toHaveClass('language-toggle-active');
      expect(screen.getByText('EN')).toHaveClass('language-toggle-inactive');
    });

    it('switches back to English labels on second toggle click', async () => {
      renderNav();

      const user = userEvent.setup();
      // Toggle to Hindi
      await user.click(screen.getByTestId('language-toggle'));
      expect(screen.getByText('ऑनबोर्डिंग')).toBeInTheDocument();

      // Toggle back to English
      await user.click(screen.getByTestId('language-toggle'));
      expect(screen.getByText('Onboarding')).toBeInTheDocument();
      expect(screen.getByText('Worker')).toBeInTheDocument();
    });
  });

  // ─── Nav Structure Preserved ──────────────────────────────────────────

  describe('nav structure preserved across locales', () => {
    it('maintains correct href values after locale change', async () => {
      renderNav();

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      // All 5 links should still have correct hrefs
      const links = screen.getAllByRole('link');
      const hrefs = links.map((l) => l.getAttribute('href'));
      expect(hrefs).toContain('/');
      expect(hrefs).toContain('/requester');
      expect(hrefs).toContain('/worker');
      expect(hrefs).toContain('/moderator');
      expect(hrefs).toContain('/admin');
    });

    it('still has 5 navigation links after locale change', async () => {
      renderNav();

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(5);
    });

    it('navigation element is still present after locale change', async () => {
      renderNav();

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(screen.getByRole('navigation')).toBeInTheDocument();
    });
  });
});
