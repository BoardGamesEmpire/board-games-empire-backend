import {
  canonicalizeLocale,
  isWellFormedBcp47,
  resolveLocalizedString,
  resolveLocalizedStringDetailed,
} from './localized-string.js';

describe('localized-string', () => {
  describe('isWellFormedBcp47', () => {
    it.each(['en', 'de-DE', 'zh-Hant', 'pt-BR', 'sr-Latn-RS'])("accepts '%s'", (tag) => {
      expect(isWellFormedBcp47(tag)).toBe(true);
    });

    it.each(['de_DE', 'en-', '', 'not a tag', 'a', '123'])("rejects '%s'", (tag) => {
      expect(isWellFormedBcp47(tag)).toBe(false);
    });
  });

  describe('canonicalizeLocale', () => {
    it('canonicalizes casing', () => {
      expect(canonicalizeLocale('en-us')).toBe('en-US');
    });
  });

  describe('resolveLocalizedStringDetailed', () => {
    const value = { en: 'Hello', 'de-DE': 'Hallo aus Deutschland', de: 'Hallo' } as const;
    const defaults = { defaultLocale: 'en' } as const;

    it('treats a bare string as the default locale, flagging fallback when the requester differs', () => {
      expect(resolveLocalizedStringDetailed('Hi', { ...defaults, locale: 'fr' })).toEqual({
        value: 'Hi',
        locale: 'en',
        usedFallback: true,
      });
    });

    it('treats a bare string as a non-fallback hit when the requester is the default locale', () => {
      expect(resolveLocalizedStringDetailed('Hi', { locale: 'en-US', defaultLocale: 'en-us' })).toEqual({
        value: 'Hi',
        locale: 'en-us',
        usedFallback: false,
      });
    });

    it('serves an exact match, case-insensitively', () => {
      expect(resolveLocalizedStringDetailed(value, { ...defaults, locale: 'de-de' })).toEqual({
        value: 'Hallo aus Deutschland',
        locale: 'de-DE',
        usedFallback: false,
      });
    });

    it('falls back from a regional tag to its base language', () => {
      expect(resolveLocalizedStringDetailed(value, { ...defaults, locale: 'de-AT' })).toEqual({
        value: 'Hallo',
        locale: 'de',
        usedFallback: true,
      });
    });

    it('serves another regional variant of the requested language before dropping to the default locale', () => {
      const germanOnlyRegional = { en: 'Hello', 'de-DE': 'Hallo aus Deutschland' } as const;

      expect(resolveLocalizedStringDetailed(germanOnlyRegional, { ...defaults, locale: 'de-AT' })).toEqual({
        value: 'Hallo aus Deutschland',
        locale: 'de-DE',
        usedFallback: true,
      });
      expect(resolveLocalizedStringDetailed(germanOnlyRegional, { ...defaults, locale: 'de' })).toEqual({
        value: 'Hallo aus Deutschland',
        locale: 'de-DE',
        usedFallback: true,
      });
    });

    it('falls back to the default locale when nothing matches', () => {
      expect(resolveLocalizedStringDetailed(value, { ...defaults, locale: 'ja' })).toEqual({
        value: 'Hello',
        locale: 'en',
        usedFallback: true,
      });
    });

    it('prefers the default locale over an arbitrary first entry when the requested locale is absent', () => {
      const resolved = resolveLocalizedStringDetailed({ fr: 'Bonjour', en: 'Hello' }, { ...defaults, locale: 'ja' });

      expect(resolved).toEqual({ value: 'Hello', locale: 'en', usedFallback: true });
    });

    it('serves the first well-formed entry only when even the default locale is absent (defensive path)', () => {
      const resolved = resolveLocalizedStringDetailed({ fr: 'Bonjour' }, { ...defaults, locale: 'ja' });

      expect(resolved).toEqual({ value: 'Bonjour', locale: 'fr', usedFallback: true });
    });

    it('throws when no entry is well-formed', () => {
      expect(() => resolveLocalizedStringDetailed({ de_DE: 'kaputt' }, { ...defaults, locale: 'de' })).toThrow(
        RangeError,
      );
    });
  });

  describe('resolveLocalizedString', () => {
    it('returns only the text', () => {
      expect(resolveLocalizedString({ en: 'Hello' }, { locale: 'en', defaultLocale: 'en' })).toBe('Hello');
    });
  });
});
