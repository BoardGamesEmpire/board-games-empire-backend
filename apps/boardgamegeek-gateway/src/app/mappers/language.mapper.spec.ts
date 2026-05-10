import * as proto from '@board-games-empire/proto-gateway';
import { BggLinkType } from '../constants';
import type { BggLink } from '../types';
import { resolveLocaleLanguageNames, toLanguageData, toLanguageDataList } from './language.mapper';

describe('toLanguageData', () => {
  it('maps a recognized language link to LanguageData with iso codes', () => {
    const link: BggLink = { type: BggLinkType.Language, id: 2184, value: 'English' };

    expect(toLanguageData(link)).toEqual({
      iso6393: 'eng',
      iso6391: 'en',
      name: 'English',
    } satisfies proto.LanguageData);
  });

  it('maps Afrikaans correctly (per BGG sample response)', () => {
    const link: BggLink = { type: BggLinkType.Language, id: 2677, value: 'Afrikaans' };

    expect(toLanguageData(link)).toEqual({
      iso6393: 'afr',
      iso6391: 'af',
      name: 'Afrikaans',
    } satisfies proto.LanguageData);
  });

  it('returns null for an unrecognized language name', () => {
    const link: BggLink = { type: BggLinkType.Language, id: 9999, value: 'Klingon' };

    expect(toLanguageData(link)).toBeNull();
  });

  it('returns null when the link is not a language link', () => {
    const link: BggLink = { type: BggLinkType.BoardGamePublisher, id: 31418, value: 'Catan Studio' };

    expect(toLanguageData(link)).toBeNull();
  });
});

describe('toLanguageDataList', () => {
  it('returns an empty array when given no links', () => {
    expect(toLanguageDataList([])).toEqual([]);
  });

  it('filters out non-language links', () => {
    const links: BggLink[] = [
      { type: BggLinkType.Language, id: 1, value: 'English' },
      { type: BggLinkType.BoardGamePublisher, id: 2, value: 'Catan Studio' },
      { type: BggLinkType.BoardGameDesigner, id: 3, value: 'Klaus Teuber' },
    ];

    const result = toLanguageDataList(links);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('English');
  });

  it('skips unknown languages without throwing', () => {
    const links: BggLink[] = [
      { type: BggLinkType.Language, id: 1, value: 'English' },
      { type: BggLinkType.Language, id: 2, value: 'Klingon' },
      { type: BggLinkType.Language, id: 3, value: 'German' },
    ];

    const result = toLanguageDataList(links);

    expect(result.map((l) => l.name)).toEqual(['English', 'German']);
  });

  it('deduplicates languages by iso6393', () => {
    const links: BggLink[] = [
      { type: BggLinkType.Language, id: 1, value: 'English' },
      { type: BggLinkType.Language, id: 2, value: 'English' },
    ];

    expect(toLanguageDataList(links)).toHaveLength(1);
  });

  it('preserves order of first occurrence', () => {
    const links: BggLink[] = [
      { type: BggLinkType.Language, id: 1, value: 'German' },
      { type: BggLinkType.Language, id: 2, value: 'English' },
      { type: BggLinkType.Language, id: 3, value: 'French' },
    ];

    expect(toLanguageDataList(links).map((l) => l.iso6393)).toEqual(['deu', 'eng', 'fra']);
  });
});

describe('resolveLocaleLanguageNames', () => {
  it('resolves a 2-char tag to the matching BGG language name', () => {
    expect(resolveLocaleLanguageNames('en')).toEqual(['English']);
    expect(resolveLocaleLanguageNames('de')).toEqual(['German']);
    expect(resolveLocaleLanguageNames('fr')).toEqual(['French']);
  });

  it('strips region subtag from BCP 47 locales', () => {
    expect(resolveLocaleLanguageNames('en-US')).toEqual(['English']);
    expect(resolveLocaleLanguageNames('de-DE')).toEqual(['German']);
  });

  it('is case-insensitive on the language subtag', () => {
    expect(resolveLocaleLanguageNames('EN')).toEqual(['English']);
    expect(resolveLocaleLanguageNames('De-de')).toEqual(['German']);
  });

  it('returns an empty array for an unknown language tag', () => {
    expect(resolveLocaleLanguageNames('xx')).toEqual([]);
  });

  it('returns an empty array for undefined locale', () => {
    expect(resolveLocaleLanguageNames(undefined)).toEqual([]);
  });

  it('returns an empty array for empty / whitespace-only locale', () => {
    expect(resolveLocaleLanguageNames('')).toEqual([]);
    expect(resolveLocaleLanguageNames('   ')).toEqual([]);
  });
});
