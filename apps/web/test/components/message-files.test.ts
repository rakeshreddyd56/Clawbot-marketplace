import { describe, it, expect } from 'vitest';
import enMessages from '../../messages/en.json';
import hiMessages from '../../messages/hi.json';

type Messages = Record<string, Record<string, string>>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Recursively collect all dotted keys from a messages object. */
function collectKeys(messages: Messages): string[] {
  const keys: string[] = [];
  for (const [namespace, fields] of Object.entries(messages)) {
    for (const field of Object.keys(fields)) {
      keys.push(`${namespace}.${field}`);
    }
  }
  return keys.sort();
}

/** Extract {param} placeholders from a string. */
function extractParams(value: string): string[] {
  const matches = value.match(/\{(\w+)\}/g);
  return matches ? matches.sort() : [];
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Translation message files', () => {
  const en = enMessages as Messages;
  const hi = hiMessages as Messages;
  const enKeys = collectKeys(en);
  const hiKeys = collectKeys(hi);

  // ─── Key Parity ──────────────────────────────────────────────────────

  describe('key parity between en.json and hi.json', () => {
    it('en.json and hi.json have the same number of keys', () => {
      expect(enKeys.length).toBe(hiKeys.length);
    });

    it('every key in en.json exists in hi.json', () => {
      const missingInHi = enKeys.filter((k) => !hiKeys.includes(k));
      expect(missingInHi).toEqual([]);
    });

    it('every key in hi.json exists in en.json', () => {
      const missingInEn = hiKeys.filter((k) => !enKeys.includes(k));
      expect(missingInEn).toEqual([]);
    });

    it('both files have the same namespaces', () => {
      const enNamespaces = Object.keys(en).sort();
      const hiNamespaces = Object.keys(hi).sort();
      expect(enNamespaces).toEqual(hiNamespaces);
    });
  });

  // ─── Required Keys Present ───────────────────────────────────────────

  describe('required keys are present', () => {
    // Nav keys
    it.each([
      'nav.onboarding',
      'nav.requester',
      'nav.worker',
      'nav.moderator',
      'nav.admin',
      'nav.models',
      'nav.home',
    ])('has key "%s" in both locales', (key) => {
      expect(enKeys).toContain(key);
      expect(hiKeys).toContain(key);
    });

    // Catalog keys
    it.each([
      'catalog.searchPlaceholder',
      'catalog.filterOrigin',
      'catalog.filterCapability',
      'catalog.filterLanguage',
      'catalog.indianOriginOnly',
      'catalog.sortBy',
    ])('has key "%s" in both locales', (key) => {
      expect(enKeys).toContain(key);
      expect(hiKeys).toContain(key);
    });

    // Model card keys
    it.each([
      'modelCard.capabilities',
      'modelCard.languages',
      'modelCard.indianLanguages',
      'modelCard.origin',
      'modelCard.provider',
      'modelCard.license',
      'modelCard.parameters',
      'modelCard.viewDetails',
    ])('has key "%s" in both locales', (key) => {
      expect(enKeys).toContain(key);
      expect(hiKeys).toContain(key);
    });

    // Model detail keys
    it.each([
      'modelDetail.description',
      'modelDetail.useCases',
      'modelDetail.reviews',
      'modelDetail.rateThisModel',
      'modelDetail.submitRating',
    ])('has key "%s" in both locales', (key) => {
      expect(enKeys).toContain(key);
      expect(hiKeys).toContain(key);
    });

    // Common keys
    it.each([
      'common.loadMore',
      'common.noResults',
      'common.ratingCount',
      'common.loading',
      'common.error',
      'common.retry',
    ])('has key "%s" in both locales', (key) => {
      expect(enKeys).toContain(key);
      expect(hiKeys).toContain(key);
    });
  });

  // ─── Value Quality ───────────────────────────────────────────────────

  describe('value quality', () => {
    it('no English values are empty strings', () => {
      const emptyKeys: string[] = [];
      for (const [ns, fields] of Object.entries(en)) {
        for (const [field, value] of Object.entries(fields)) {
          if (value.trim() === '') {
            emptyKeys.push(`${ns}.${field}`);
          }
        }
      }
      expect(emptyKeys).toEqual([]);
    });

    it('no Hindi values are empty strings', () => {
      const emptyKeys: string[] = [];
      for (const [ns, fields] of Object.entries(hi)) {
        for (const [field, value] of Object.entries(fields)) {
          if (value.trim() === '') {
            emptyKeys.push(`${ns}.${field}`);
          }
        }
      }
      expect(emptyKeys).toEqual([]);
    });

    it('Hindi values contain Devanagari characters (not just English)', () => {
      const devanagariRegex = /[\u0900-\u097F]/;
      const nonDevanagariKeys: string[] = [];

      for (const [ns, fields] of Object.entries(hi)) {
        for (const [field, value] of Object.entries(fields)) {
          // Skip values that are expected to be identical (like brand names)
          if (!devanagariRegex.test(value)) {
            nonDevanagariKeys.push(`${ns}.${field}`);
          }
        }
      }

      // All Hindi values should contain at least some Devanagari characters
      expect(nonDevanagariKeys).toEqual([]);
    });

    it('Hindi values are different from English values', () => {
      const identicalKeys: string[] = [];

      for (const [ns, fields] of Object.entries(en)) {
        for (const [field, value] of Object.entries(fields)) {
          const hiValue = hi[ns]?.[field];
          if (hiValue === value) {
            identicalKeys.push(`${ns}.${field}`);
          }
        }
      }

      // No Hindi translation should be identical to English
      expect(identicalKeys).toEqual([]);
    });
  });

  // ─── Parameter Consistency ───────────────────────────────────────────

  describe('parameter placeholder consistency', () => {
    it('en and hi have matching {param} placeholders for all keys', () => {
      const mismatches: string[] = [];

      for (const [ns, fields] of Object.entries(en)) {
        for (const [field, value] of Object.entries(fields)) {
          const enParams = extractParams(value);
          const hiValue = hi[ns]?.[field] ?? '';
          const hiParams = extractParams(hiValue);

          if (JSON.stringify(enParams) !== JSON.stringify(hiParams)) {
            mismatches.push(
              `${ns}.${field}: EN has ${JSON.stringify(enParams)}, HI has ${JSON.stringify(hiParams)}`
            );
          }
        }
      }

      expect(mismatches).toEqual([]);
    });

    it('"common.ratingCount" has {count} placeholder in both locales', () => {
      expect(en.common.ratingCount).toContain('{count}');
      expect(hi.common.ratingCount).toContain('{count}');
    });
  });

  // ─── Structural Validity ─────────────────────────────────────────────

  describe('structural validity', () => {
    it('en.json is a valid 2-level deep object', () => {
      for (const [namespace, fields] of Object.entries(en)) {
        expect(typeof namespace).toBe('string');
        expect(typeof fields).toBe('object');
        for (const [field, value] of Object.entries(fields)) {
          expect(typeof field).toBe('string');
          expect(typeof value).toBe('string');
        }
      }
    });

    it('hi.json is a valid 2-level deep object', () => {
      for (const [namespace, fields] of Object.entries(hi)) {
        expect(typeof namespace).toBe('string');
        expect(typeof fields).toBe('object');
        for (const [field, value] of Object.entries(fields)) {
          expect(typeof field).toBe('string');
          expect(typeof value).toBe('string');
        }
      }
    });

    it('has at least 5 namespaces', () => {
      expect(Object.keys(en).length).toBeGreaterThanOrEqual(5);
      expect(Object.keys(hi).length).toBeGreaterThanOrEqual(5);
    });

    it('has at least 20 total translation keys', () => {
      expect(enKeys.length).toBeGreaterThanOrEqual(20);
      expect(hiKeys.length).toBeGreaterThanOrEqual(20);
    });
  });
});
