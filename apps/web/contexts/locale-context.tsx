'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import enMessages from '../messages/en.json';
import hiMessages from '../messages/hi.json';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Locale = 'en' | 'hi';

/** Nested message dictionary — max 2 levels deep (namespace.key). */
export type Messages = Record<string, Record<string, string>>;

export type LocaleContextValue = {
  /** Current active locale. */
  locale: Locale;
  /** Switch locale and persist to localStorage + cookie. */
  setLocale: (locale: Locale) => void;
  /** Retrieve a translated string by dotted key (e.g. "nav.home"). */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Full message dictionary for current locale. */
  messages: Messages;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'clawbot_locale';
const COOKIE_NAME = 'NEXT_LOCALE';
const DEFAULT_LOCALE: Locale = 'en';
const SUPPORTED_LOCALES: Locale[] = ['en', 'hi'];

const MESSAGE_MAP: Record<Locale, Messages> = {
  en: enMessages as Messages,
  hi: hiMessages as Messages,
};

// ─── Context ─────────────────────────────────────────────────────────────────

const LocaleContext = createContext<LocaleContextValue | null>(null);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isValidLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as Locale);
}

/** Read locale from localStorage, falling back to cookie, then default. */
function readPersistedLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;

  // 1. Try localStorage
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isValidLocale(stored)) return stored;
  } catch {
    // localStorage may be disabled — ignore.
  }

  // 2. Try cookie
  try {
    const match = document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (match) {
      const val = match.split('=')[1];
      if (isValidLocale(val)) return val;
    }
  } catch {
    // ignore
  }

  return DEFAULT_LOCALE;
}

/** Persist locale to both localStorage and a session cookie. */
function persistLocale(locale: Locale): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // localStorage may be disabled — ignore.
  }

  try {
    document.cookie = `${COOKIE_NAME}=${locale};path=/;SameSite=Lax;max-age=31536000`;
  } catch {
    // ignore
  }
}

/** Update the <html lang="…"> attribute on the document root. */
function updateHtmlLang(locale: Locale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

/** Resolve a dotted key like "nav.home" against the messages dictionary. */
function resolveKey(messages: Messages, key: string): string | undefined {
  const [namespace, field] = key.split('.');
  if (!namespace || !field) return undefined;
  return messages[namespace]?.[field];
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  // On mount, read persisted locale
  useEffect(() => {
    const persisted = readPersistedLocale();
    setLocaleState(persisted);
    updateHtmlLang(persisted);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    if (!isValidLocale(next)) return;
    setLocaleState(next);
    persistLocale(next);
    updateHtmlLang(next);
  }, []);

  const messages = MESSAGE_MAP[locale];

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      // Try current locale
      let value = resolveKey(MESSAGE_MAP[locale], key);

      // Fallback to English if key missing in current locale
      if (value === undefined && locale !== 'en') {
        value = resolveKey(MESSAGE_MAP.en, key);
      }

      // If still missing, return the key itself
      if (value === undefined) return key;

      // Interpolate parameters like {count}
      if (params) {
        for (const [param, replacement] of Object.entries(params)) {
          value = value.replace(`{${param}}`, String(replacement));
        }
      }

      return value;
    },
    [locale],
  );

  const contextValue = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t, messages }),
    [locale, setLocale, t, messages],
  );

  return (
    <LocaleContext.Provider value={contextValue}>
      {children}
    </LocaleContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useLocale must be used within a <LocaleProvider>');
  }
  return ctx;
}
