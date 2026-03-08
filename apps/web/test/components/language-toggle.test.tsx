import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LanguageToggle } from '../../components/language-toggle';
import { LocaleProvider, useLocale } from '../../contexts/locale-context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}

/** Wrapper that also shows current locale for assertions. */
function ToggleWithLocaleDisplay() {
  const { locale } = useLocale();
  return (
    <div>
      <span data-testid="current-locale">{locale}</span>
      <LanguageToggle />
    </div>
  );
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('LanguageToggle', () => {
  beforeEach(() => {
    // Reset localStorage
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    // Reset cookie
    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: '',
    });
    document.documentElement.lang = 'en';
  });

  // ─── Rendering ─────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders as a button element', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('renders "EN" label', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByText('EN')).toBeInTheDocument();
    });

    it('renders Hindi label "हिन्दी"', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByText('हिन्दी')).toBeInTheDocument();
    });

    it('renders separator between EN and हिन्दी', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      const separator = screen.getByText('|');
      expect(separator).toBeInTheDocument();
      expect(separator).toHaveAttribute('aria-hidden', 'true');
    });

    it('has data-testid="language-toggle"', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByTestId('language-toggle')).toBeInTheDocument();
    });

    it('has class "language-toggle"', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByTestId('language-toggle')).toHaveClass('language-toggle');
    });
  });

  // ─── Active/Inactive Styling ──────────────────────────────────────────

  describe('active/inactive styling', () => {
    it('shows EN as active when locale is English', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByText('EN')).toHaveClass('language-toggle-active');
      expect(screen.getByText('हिन्दी')).toHaveClass('language-toggle-inactive');
    });

    it('shows हिन्दी as active after switching to Hindi', async () => {
      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(screen.getByText('हिन्दी')).toHaveClass('language-toggle-active');
      expect(screen.getByText('EN')).toHaveClass('language-toggle-inactive');
    });

    it('reverts EN to active after toggling back', async () => {
      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      // Toggle to Hindi
      await user.click(screen.getByTestId('language-toggle'));
      expect(screen.getByText('हिन्दी')).toHaveClass('language-toggle-active');

      // Toggle back to English
      await user.click(screen.getByTestId('language-toggle'));
      expect(screen.getByText('EN')).toHaveClass('language-toggle-active');
    });
  });

  // ─── Toggle Behavior ─────────────────────────────────────────────────

  describe('toggle behavior', () => {
    it('switches from English to Hindi on click', async () => {
      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      expect(screen.getByTestId('current-locale')).toHaveTextContent('en');

      await user.click(screen.getByTestId('language-toggle'));

      expect(screen.getByTestId('current-locale')).toHaveTextContent('hi');
    });

    it('switches from Hindi to English on second click', async () => {
      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));
      expect(screen.getByTestId('current-locale')).toHaveTextContent('hi');

      await user.click(screen.getByTestId('language-toggle'));
      expect(screen.getByTestId('current-locale')).toHaveTextContent('en');
    });

    it('does not reload the page when toggling', async () => {
      const originalHref = window.location.href;

      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(window.location.href).toBe(originalHref);
    });

    it('updates html lang attribute when toggling', async () => {
      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(document.documentElement.lang).toBe('hi');
    });

    it('persists the locale to localStorage when toggling', async () => {
      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(localStorage.setItem).toHaveBeenCalledWith('clawbot_locale', 'hi');
    });
  });

  // ─── Accessibility ────────────────────────────────────────────────────

  describe('accessibility', () => {
    it('has aria-label indicating switch to Hindi when in English', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByTestId('language-toggle')).toHaveAttribute(
        'aria-label',
        'Switch language to Hindi'
      );
    });

    it('has aria-label indicating switch to English when in Hindi', async () => {
      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(screen.getByTestId('language-toggle')).toHaveAttribute(
        'aria-label',
        'Switch language to English'
      );
    });

    it('has aria-pressed=false when in English mode', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByTestId('language-toggle')).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });

    it('has aria-pressed=true when in Hindi mode', async () => {
      render(
        <Wrapper>
          <ToggleWithLocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('language-toggle'));

      expect(screen.getByTestId('language-toggle')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('button is of type="button" (not submit)', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      expect(screen.getByTestId('language-toggle')).toHaveAttribute('type', 'button');
    });

    it('separator pipe is aria-hidden', () => {
      render(
        <Wrapper>
          <LanguageToggle />
        </Wrapper>
      );
      const separator = screen.getByText('|');
      expect(separator).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
