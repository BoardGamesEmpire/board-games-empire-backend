import { IGDB_LANGUAGES, resolveLanguageIdList, resolveLanguageIds } from './language.mapper';

describe('resolveLanguageIds', () => {
  describe('exact match', () => {
    it('returns a single id for an exact locale match', () => {
      expect(resolveLanguageIds('en-US')).toEqual([7]);
    });

    it('distinguishes en-US (id 7) from en-GB (id 8)', () => {
      expect(resolveLanguageIds('en-US')).toEqual([7]);
      expect(resolveLanguageIds('en-GB')).toEqual([8]);
    });

    it('distinguishes zh-CN (id 2) from zh-TW (id 3)', () => {
      expect(resolveLanguageIds('zh-CN')).toEqual([2]);
      expect(resolveLanguageIds('zh-TW')).toEqual([3]);
    });

    it('distinguishes es-ES (id 9) from es-MX (id 10)', () => {
      expect(resolveLanguageIds('es-ES')).toEqual([9]);
      expect(resolveLanguageIds('es-MX')).toEqual([10]);
    });

    it('distinguishes pt-PT (id 20) from pt-BR (id 21)', () => {
      expect(resolveLanguageIds('pt-PT')).toEqual([20]);
      expect(resolveLanguageIds('pt-BR')).toEqual([21]);
    });

    it('is case-insensitive', () => {
      expect(resolveLanguageIds('EN-US')).toEqual([7]);
      expect(resolveLanguageIds('De-De')).toEqual([27]);
    });

    it('returns [] for an unknown full locale', () => {
      expect(resolveLanguageIds('en-AU')).toEqual([]);
    });
  });

  describe('prefix match', () => {
    it('returns all variants for a 2-char tag with multiple locales', () => {
      expect(resolveLanguageIds('en')).toEqual(expect.arrayContaining([7, 8]));
      expect(resolveLanguageIds('en')).toHaveLength(2);
    });

    it('returns all Spanish variants for "es"', () => {
      expect(resolveLanguageIds('es')).toEqual(expect.arrayContaining([9, 10]));
      expect(resolveLanguageIds('es')).toHaveLength(2);
    });

    it('returns all Chinese variants for "zh"', () => {
      expect(resolveLanguageIds('zh')).toEqual(expect.arrayContaining([2, 3]));
      expect(resolveLanguageIds('zh')).toHaveLength(2);
    });

    it('returns all Portuguese variants for "pt"', () => {
      expect(resolveLanguageIds('pt')).toEqual(expect.arrayContaining([20, 21]));
      expect(resolveLanguageIds('pt')).toHaveLength(2);
    });

    it('returns a single id for a 2-char tag with only one locale', () => {
      expect(resolveLanguageIds('de')).toEqual([27]);
      expect(resolveLanguageIds('ja')).toEqual([16]);
      expect(resolveLanguageIds('fr')).toEqual([12]);
    });

    it('is case-insensitive', () => {
      expect(resolveLanguageIds('EN')).toEqual(expect.arrayContaining([7, 8]));
    });

    it('returns [] for an unknown 2-char tag', () => {
      expect(resolveLanguageIds('xx')).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('trims surrounding whitespace before matching', () => {
      expect(resolveLanguageIds('  en-US  ')).toEqual([7]);
      expect(resolveLanguageIds('  en  ')).toEqual(expect.arrayContaining([7, 8]));
    });
  });
});

describe('resolveLanguageIdList', () => {
  it('resolves a list of full locales to their ids', () => {
    expect(resolveLanguageIdList(['en-US', 'fr-FR'])).toEqual(expect.arrayContaining([7, 12]));
    expect(resolveLanguageIdList(['en-US', 'fr-FR'])).toHaveLength(2);
  });

  it('resolves a mix of 2-char tags and full locales', () => {
    // 'en' expands to [7, 8]; 'fr-FR' adds 12
    const result = resolveLanguageIdList(['en', 'fr-FR']);
    expect(result).toEqual(expect.arrayContaining([7, 8, 12]));
    expect(result).toHaveLength(3);
  });

  it('deduplicates ids when a 2-char tag and its specific variant are both provided', () => {
    // 'en' → [7, 8]; 'en-US' → [7]; union should still be [7, 8]
    const result = resolveLanguageIdList(['en', 'en-US']);
    expect(result).toEqual(expect.arrayContaining([7, 8]));
    expect(result).toHaveLength(2);
  });

  it('returns [] for an empty list', () => {
    expect(resolveLanguageIdList([])).toEqual([]);
  });

  it('silently drops unknown locales', () => {
    expect(resolveLanguageIdList(['en-US', 'xx-XX'])).toEqual([7]);
  });
});

describe('IGDB_LANGUAGES registry', () => {
  it('contains 28 entries', () => {
    expect(IGDB_LANGUAGES).toHaveLength(28);
  });

  it('has no duplicate ids', () => {
    const ids = IGDB_LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate locales', () => {
    const locales = IGDB_LANGUAGES.map((l) => l.locale);
    expect(new Set(locales).size).toBe(locales.length);
  });

  it('every locale is either a bare 2-char tag or a valid BCP-47 subtag pair', () => {
    const pattern = /^[a-z]{2}(-[A-Z]{2})?$/;
    for (const lang of IGDB_LANGUAGES) {
      expect(lang.locale).toMatch(pattern);
    }
  });
});
