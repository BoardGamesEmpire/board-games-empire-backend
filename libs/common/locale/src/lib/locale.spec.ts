import {
  canonicalizeTag,
  displayName,
  filterTags,
  lookupTag,
  maximizeTag,
  nameKey,
  nativeDisplayName,
  parseAcceptLanguage,
  parseTag,
  resolveCatalogLocale,
} from './locale';

describe('parseAcceptLanguage', () => {
  it('returns ranges sorted by descending quality', () => {
    expect(parseAcceptLanguage('fr;q=0.8, en-US, de;q=0.9')).toEqual(['en-US', 'de', 'fr']);
  });

  it('keeps header order for equal qualities', () => {
    expect(parseAcceptLanguage('fr, de, en')).toEqual(['fr', 'de', 'en']);
    expect(parseAcceptLanguage('fr;q=0.5, de;q=0.5')).toEqual(['fr', 'de']);
  });

  it('drops q=0 ranges', () => {
    expect(parseAcceptLanguage('en;q=0, fr')).toEqual(['fr']);
  });

  it('tolerates whitespace, uppercase Q, and malformed quality values', () => {
    expect(parseAcceptLanguage(' en-US ; Q=0.9 ,fr')).toEqual(['fr', 'en-US']);
    expect(parseAcceptLanguage('en;q=abc, fr;q=0.5')).toEqual(['en', 'fr']);
    expect(parseAcceptLanguage('en;q=7, fr;q=0.5')).toEqual(['en', 'fr']);
  });

  it('passes the * wildcard through', () => {
    expect(parseAcceptLanguage('en;q=0.8, *;q=0.1')).toEqual(['en', '*']);
  });

  it('skips empty items', () => {
    expect(parseAcceptLanguage('en,,fr,')).toEqual(['en', 'fr']);
  });

  it('returns [] for missing or empty headers', () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
    expect(parseAcceptLanguage('   ')).toEqual([]);
  });

  it('feeds lookupTag as a prioritized range list', () => {
    expect(lookupTag(parseAcceptLanguage('fr-CA;q=0.9, en-US;q=0.8'), ['en', 'es'])).toBe('en');
  });
});

describe('canonicalizeTag', () => {
  it('normalizes casing to canonical form', () => {
    expect(canonicalizeTag('EN-us')).toBe('en-US');
    expect(canonicalizeTag('ZH-hant')).toBe('zh-Hant');
    expect(canonicalizeTag('pt-br')).toBe('pt-BR');
  });

  it('passes through already-canonical tags', () => {
    expect(canonicalizeTag('en')).toBe('en');
    expect(canonicalizeTag('zh-Hant-TW')).toBe('zh-Hant-TW');
  });

  it('rejects deprecated extlang forms (ICU treats them as invalid)', () => {
    expect(canonicalizeTag('zh-cmn-Hans')).toBeNull();
  });

  it('rejects invalid syntax', () => {
    expect(canonicalizeTag('not a tag')).toBeNull();
    expect(canonicalizeTag('-en')).toBeNull();
    expect(canonicalizeTag('en-')).toBeNull();
  });

  it('rejects 4–8 letter primary subtags (free-text names)', () => {
    expect(canonicalizeTag('English')).toBeNull();
    expect(canonicalizeTag('klingon')).toBeNull();
  });

  it('rejects empty and nullish input', () => {
    expect(canonicalizeTag('')).toBeNull();
    expect(canonicalizeTag('   ')).toBeNull();
    expect(canonicalizeTag(null)).toBeNull();
    expect(canonicalizeTag(undefined)).toBeNull();
  });
});

describe('parseTag', () => {
  it('decomposes explicit subtags only', () => {
    expect(parseTag('zh-Hant-TW')).toEqual({ tag: 'zh-Hant-TW', language: 'zh', script: 'Hant', region: 'TW' });
    expect(parseTag('en')).toEqual({ tag: 'en', language: 'en', script: undefined, region: undefined });
  });

  it('returns null for invalid input', () => {
    expect(parseTag('English')).toBeNull();
  });
});

describe('maximizeTag', () => {
  it('adds likely subtags', () => {
    const zh = maximizeTag('zh');
    expect(zh?.script).toBe('Hans');
    expect(zh?.region).toBe('CN');

    const en = maximizeTag('en');
    expect(en?.script).toBe('Latn');
    expect(en?.region).toBe('US');
  });
});

describe('lookupTag', () => {
  const available = ['en', 'en-GB', 'pt-BR', 'zh-Hant', 'zh'];

  it('returns an exact match', () => {
    expect(lookupTag(['pt-BR'], available)).toBe('pt-BR');
  });

  it('truncates to the closest available prefix', () => {
    expect(lookupTag(['en-US'], available)).toBe('en');
    expect(lookupTag(['zh-Hant-TW'], available)).toBe('zh-Hant');
  });

  it('is case-insensitive and preserves stored casing', () => {
    expect(lookupTag(['ZH-HANT'], available)).toBe('zh-Hant');
  });

  it('honors range priority order', () => {
    expect(lookupTag(['fr', 'en-GB'], available)).toBe('en-GB');
  });

  it('returns undefined when nothing matches', () => {
    expect(lookupTag(['ja', 'ko'], available)).toBeUndefined();
    expect(lookupTag([], available)).toBeUndefined();
  });
});

describe('filterTags', () => {
  const available = ['zh', 'zh-Hans', 'zh-Hant', 'zh-Hant-TW', 'en'];

  it('matches at subtag boundaries only', () => {
    expect(filterTags('zh', available)).toEqual(['zh', 'zh-Hans', 'zh-Hant', 'zh-Hant-TW']);
    expect(filterTags('zh-Hant', available)).toEqual(['zh-Hant', 'zh-Hant-TW']);
  });

  it('does not treat a bare prefix as a boundary', () => {
    expect(filterTags('z', available)).toEqual([]);
  });

  it('supports the wildcard range', () => {
    expect(filterTags('*', available)).toEqual(available);
  });

  it('returns empty for blank ranges', () => {
    expect(filterTags('', available)).toEqual([]);
  });
});

describe('resolveCatalogLocale', () => {
  const supported = ['en', 'en-GB', 'pt-BR', 'zh-Hant', 'zh'];

  it('returns an exact match', () => {
    expect(resolveCatalogLocale(['pt-BR'], supported, 'en')).toBe('pt-BR');
  });

  it('truncates to the closest supported catalog', () => {
    expect(resolveCatalogLocale(['en-US'], supported, 'en')).toBe('en');
    expect(resolveCatalogLocale(['zh-Hant-TW'], supported, 'en')).toBe('zh-Hant');
  });

  it('honors range priority order', () => {
    expect(resolveCatalogLocale(['fr', 'en-GB'], supported, 'en')).toBe('en-GB');
  });

  it('falls back when nothing matches', () => {
    expect(resolveCatalogLocale(['ja', 'ko'], supported, 'en')).toBe('en');
    expect(resolveCatalogLocale([], supported, 'en')).toBe('en');
  });
});

describe('displayName', () => {
  it('produces standard-style English names', () => {
    expect(displayName('en')).toBe('English');
    expect(displayName('en-US')).toBe('English (United States)');
    expect(displayName('zh-Hant')).toBe('Chinese (Traditional)');
  });

  it('localizes to the requested display locale', () => {
    expect(displayName('de', 'de')).toBe('Deutsch');
  });

  it('returns null for invalid tags', () => {
    expect(displayName('English')).toBeNull();
  });
});

describe('nativeDisplayName', () => {
  it('names a tag in its own language', () => {
    expect(nativeDisplayName('de')).toBe('Deutsch');
    expect(nativeDisplayName('ja')).toBe('日本語');
  });
});

describe('nameKey', () => {
  it('trims, collapses whitespace, and lowercases', () => {
    expect(nameKey('  Chinese   (Traditional) ')).toBe('chinese (traditional)');
    expect(nameKey('Czech')).toBe('czech');
  });

  it('returns null for blank input', () => {
    expect(nameKey('   ')).toBeNull();
    expect(nameKey(undefined)).toBeNull();
  });
});
