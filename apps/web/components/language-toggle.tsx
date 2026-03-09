'use client';

import { useLocale } from '../contexts/locale-context';
import type { Locale } from '../contexts/locale-context';

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'EN',
  hi: 'हिन्दी',
};

/**
 * Language toggle button — switches between English and Hindi.
 * Reads/writes locale via LocaleContext (persisted to localStorage + cookie).
 */
export function LanguageToggle() {
  const { locale, setLocale } = useLocale();

  const nextLocale: Locale = locale === 'en' ? 'hi' : 'en';

  return (
    <button
      type="button"
      className="language-toggle"
      data-testid="language-toggle"
      onClick={() => setLocale(nextLocale)}
      aria-label={`Switch language to ${nextLocale === 'hi' ? 'Hindi' : 'English'}`}
      aria-pressed={locale === 'hi'}
    >
      <span className={locale === 'en' ? 'language-toggle-active' : 'language-toggle-inactive'}>EN</span>
      <span aria-hidden="true"> | </span>
      <span className={locale === 'hi' ? 'language-toggle-active' : 'language-toggle-inactive'}>हिन्दी</span>
    </button>
  );
}
