import * as proto from '@boardgamesempire/proto-gateway';
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

  it('passes a name the map doesn’t know on as a name, so the server can hold it for review (#717)', () => {
    const link: BggLink = { type: BggLinkType.Language, id: 9999, value: 'Klingon' };

    const result = toLanguageData(link);

    expect(result).toEqual({ name: 'Klingon' });
    expect(result?.iso6393).toBeUndefined();
  });

  it('passes a name that is also an Object.prototype key on as a name (#717)', () => {
    expect(toLanguageData({ type: BggLinkType.Language, id: 9996, value: 'constructor' })).toEqual({
      name: 'constructor',
    });
    expect(toLanguageData({ type: BggLinkType.Language, id: 9995, value: 'toString' })).toEqual({ name: 'toString' });
  });

  it('skips a language link with a blank value (#717)', () => {
    expect(toLanguageData({ type: BggLinkType.Language, id: 9998, value: '' })).toBeNull();
    expect(toLanguageData({ type: BggLinkType.Language, id: 9998, value: '  ' })).toBeNull();
  });

  it('skips a language link with no value, rather than sending a nameless one (#717)', () => {
    expect(toLanguageData({ type: BggLinkType.Language, id: 9997 } as BggLink)).toBeNull();
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

  it('keeps an unknown name beside the known ones, each once (#717)', () => {
    const links: BggLink[] = [
      { type: BggLinkType.Language, id: 1, value: 'English' },
      { type: BggLinkType.Language, id: 2, value: 'Klingon' },
      { type: BggLinkType.Language, id: 3, value: 'Klingon' },
    ];

    expect(toLanguageDataList(links)).toEqual([
      { iso6393: 'eng', iso6391: 'en', name: 'English' },
      { name: 'Klingon' },
    ]);
  });

  it('lists a language once when two links name it (#717)', () => {
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
