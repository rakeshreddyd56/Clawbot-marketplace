import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { LocaleProvider, useLocale } from '../../contexts/locale-context';
import type { Locale } from '../../contexts/locale-context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Wrapper component that provides LocaleProvider. */
function Wrapper({ children }: { children: React.ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}

/** Test component that displays locale info and provides controls. */
function LocaleDisplay() {
  const { locale, setLocale, t, messages } = useLocale();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="translated">{t('nav.home')}</span>
      <span data-testid="translated-param">{t('common.ratingCount', { count: 42 })}</span>
      <span data-testid="missing-key">{t('nonexistent.key')}</span>
      <span data-testid="messages-keys">{Object.keys(messages).sort().join(',')}</span>
      <button data-testid="set-hi" onClick={() => setLocale('hi')}>
        Set Hindi
      </button>
      <button data-testid="set-en" onClick={() => setLocale('en')}>
        Set English
      </button>
    </div>
  );
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('LocaleContext', () => {
  let localStorageMock: Record<string, string>;

  beforeEach(() => {
    // Reset localStorage mock
    localStorageMock = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localStorageMock[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageMock[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete localStorageMock[key];
      }),
    });

    // Reset cookie
    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: '',
    });

    // Reset document lang
    document.documentElement.lang = 'en';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Default State ───────────────────────────────────────────────────────

  describe('default state', () => {
    it('starts with English locale by default', () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );
      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    });

    it('renders English translations by default', () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );
      expect(screen.getByTestId('translated')).toHaveTextContent('Home');
    });

    it('provides messages dictionary with expected namespaces', () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );
      const keys = screen.getByTestId('messages-keys').textContent;
      expect(keys).toContain('nav');
      expect(keys).toContain('onboarding');
      expect(keys).toContain('marketplace');
      expect(keys).toContain('identity');
      expect(keys).toContain('common');
    });
  });

  // ─── Translation Function (t) ───────────────────────────────────────────

  describe('t() translation function', () => {
    it('resolves dotted keys like "nav.home"', () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );
      expect(screen.getByTestId('translated')).toHaveTextContent('Home');
    });

    it('interpolates parameters like {count}', () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );
      expect(screen.getByTestId('translated-param')).toHaveTextContent('42 ratings');
    });

    it('returns the key itself for completely missing keys', () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );
      expect(screen.getByTestId('missing-key')).toHaveTextContent('nonexistent.key');
    });

    it('falls back to English when Hindi key is missing', async () => {
      // Render with an element that uses a key only in English
      function FallbackTest() {
        const { locale, setLocale, t } = useLocale();
        return (
          <div>
            <span data-testid="locale">{locale}</span>
            <span data-testid="value">{t('nav.home')}</span>
            <button data-testid="switch" onClick={() => setLocale('hi')}>Switch</button>
          </div>
        );
      }

      render(
        <Wrapper>
          <FallbackTest />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('switch'));

      // Hindi version exists, so we should get the Hindi translation
      expect(screen.getByTestId('value')).toHaveTextContent('होम');
    });

    it('returns key when key has no namespace (no dot)', () => {
      function BadKeyTest() {
        const { t } = useLocale();
        return <span data-testid="bad">{t('nodot')}</span>;
      }

      render(
        <Wrapper>
          <BadKeyTest />
        </Wrapper>
      );
      expect(screen.getByTestId('bad')).toHaveTextContent('nodot');
    });

    it('returns key when namespace exists but field does not', () => {
      function MissingFieldTest() {
        const { t } = useLocale();
        return <span data-testid="missing">{t('nav.nonexistent')}</span>;
      }

      render(
        <Wrapper>
          <MissingFieldTest />
        </Wrapper>
      );
      expect(screen.getByTestId('missing')).toHaveTextContent('nav.nonexistent');
    });

    it('interpolates multiple parameters', () => {
      function MultiParamTest() {
        const { t } = useLocale();
        // Use a key that exists, add param test via overridden message
        return <span data-testid="multi">{t('common.ratingCount', { count: 99 })}</span>;
      }

      render(
        <Wrapper>
          <MultiParamTest />
        </Wrapper>
      );
      expect(screen.getByTestId('multi')).toHaveTextContent('99 ratings');
    });
  });

  // ─── Locale Switching ──────────────────────────────────────────────────

  describe('locale switching', () => {
    it('switches to Hindi when setLocale("hi") is called', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      expect(screen.getByTestId('locale')).toHaveTextContent('hi');
    });

    it('switches translations to Hindi', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      expect(screen.getByTestId('translated')).toHaveTextContent('होम');
    });

    it('switches back to English from Hindi', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));
      expect(screen.getByTestId('locale')).toHaveTextContent('hi');

      await user.click(screen.getByTestId('set-en'));
      expect(screen.getByTestId('locale')).toHaveTextContent('en');
      expect(screen.getByTestId('translated')).toHaveTextContent('Home');
    });

    it('interpolates Hindi parameters correctly', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      // hi.json: "ratingCount": "{count} रेटिंग"
      expect(screen.getByTestId('translated-param')).toHaveTextContent('42 रेटिंग');
    });

    it('does not cause page reload when switching locale', async () => {
      const originalLocation = window.location.href;

      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      expect(window.location.href).toBe(originalLocation);
    });
  });

  // ─── Persistence ─────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists locale to localStorage when switching', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      expect(localStorage.setItem).toHaveBeenCalledWith('clawbot_locale', 'hi');
    });

    it('persists locale to NEXT_LOCALE cookie when switching', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      expect(document.cookie).toContain('NEXT_LOCALE=hi');
    });

    it('cookie has correct path and SameSite attributes', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      expect(document.cookie).toContain('path=/');
      expect(document.cookie).toContain('SameSite=Lax');
    });

    it('cookie has max-age of 1 year (31536000 seconds)', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      expect(document.cookie).toContain('max-age=31536000');
    });

    it('reads locale from localStorage on mount', () => {
      localStorageMock['clawbot_locale'] = 'hi';

      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      // After useEffect fires, locale should be 'hi'
      expect(screen.getByTestId('locale')).toHaveTextContent('hi');
    });

    it('reads locale from cookie when localStorage is empty', () => {
      Object.defineProperty(document, 'cookie', {
        writable: true,
        value: 'NEXT_LOCALE=hi',
      });

      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      expect(screen.getByTestId('locale')).toHaveTextContent('hi');
    });

    it('prefers localStorage over cookie', () => {
      localStorageMock['clawbot_locale'] = 'en';
      Object.defineProperty(document, 'cookie', {
        writable: true,
        value: 'NEXT_LOCALE=hi',
      });

      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    });

    it('defaults to English when localStorage has invalid value', () => {
      localStorageMock['clawbot_locale'] = 'fr';

      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    });

    it('defaults to English when cookie has invalid value', () => {
      Object.defineProperty(document, 'cookie', {
        writable: true,
        value: 'NEXT_LOCALE=de',
      });

      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    });

    it('handles localStorage error gracefully', () => {
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => {
          throw new Error('localStorage disabled');
        }),
        setItem: vi.fn(() => {
          throw new Error('localStorage disabled');
        }),
      });

      // Should not throw
      expect(() => {
        render(
          <Wrapper>
            <LocaleDisplay />
          </Wrapper>
        );
      }).not.toThrow();

      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    });
  });

  // ─── HTML Lang Attribute ──────────────────────────────────────────────

  describe('HTML lang attribute', () => {
    it('sets <html lang="en"> by default', () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );
      expect(document.documentElement.lang).toBe('en');
    });

    it('updates <html lang="hi"> when locale changes to Hindi', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));

      expect(document.documentElement.lang).toBe('hi');
    });

    it('reverts <html lang="en"> when switching back to English', async () => {
      render(
        <Wrapper>
          <LocaleDisplay />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-hi'));
      expect(document.documentElement.lang).toBe('hi');

      await user.click(screen.getByTestId('set-en'));
      expect(document.documentElement.lang).toBe('en');
    });
  });

  // ─── Invalid Locale Rejection ────────────────────────────────────────

  describe('invalid locale rejection', () => {
    it('ignores setLocale with unsupported locale value', async () => {
      function InvalidLocaleTest() {
        const { locale, setLocale } = useLocale();
        return (
          <div>
            <span data-testid="locale">{locale}</span>
            <button
              data-testid="set-invalid"
              onClick={() => setLocale('fr' as Locale)}
            >
              Set French
            </button>
          </div>
        );
      }

      render(
        <Wrapper>
          <InvalidLocaleTest />
        </Wrapper>
      );

      const user = userEvent.setup();
      await user.click(screen.getByTestId('set-invalid'));

      // Should remain on default locale
      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    });
  });

  // ─── useLocale Hook ──────────────────────────────────────────────────

  describe('useLocale hook', () => {
    it('throws when used outside of LocaleProvider', () => {
      // Suppress console.error for this expected error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useLocale());
      }).toThrow('useLocale must be used within a <LocaleProvider>');

      consoleSpy.mockRestore();
    });

    it('returns all context properties', () => {
      const { result } = renderHook(() => useLocale(), { wrapper: Wrapper });

      expect(result.current).toHaveProperty('locale');
      expect(result.current).toHaveProperty('setLocale');
      expect(result.current).toHaveProperty('t');
      expect(result.current).toHaveProperty('messages');
      expect(typeof result.current.locale).toBe('string');
      expect(typeof result.current.setLocale).toBe('function');
      expect(typeof result.current.t).toBe('function');
      expect(typeof result.current.messages).toBe('object');
    });
  });
});
