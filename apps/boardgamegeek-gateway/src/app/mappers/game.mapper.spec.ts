import * as proto from '@boardgamesempire/proto-gateway';
import { BggLinkType, BggNameType, BggThingType, DEFAULT_EDITION_KEY } from '../constants';
import type { BggLink, BggName, BggSearchItem, BggThing, BggVersion } from '../types';

import {
  getOutboundExpansionIds,
  isInbound,
  searchItemToGameSearchData,
  selectPrimaryName,
  thingToGameData,
  thingToGameSearchData,
} from './game.mapper';

describe('selectPrimaryName', () => {
  it('returns the entry flagged as primary', () => {
    const result = selectPrimaryName([
      { type: BggNameType.Alternate, value: 'Catan (Spanish)' },
      { type: BggNameType.Primary, value: 'Catan' },
    ]);

    expect(result).toBe('Catan');
  });

  it('falls back to the first entry when no primary is flagged', () => {
    const result = selectPrimaryName([
      { type: BggNameType.Alternate, value: 'First Alternate' },
      { type: BggNameType.Alternate, value: 'Second Alternate' },
    ]);

    expect(result).toBe('First Alternate');
  });

  it('returns undefined when given an empty array', () => {
    expect(selectPrimaryName([])).toBeUndefined();
  });

  it('returns undefined when given undefined', () => {
    expect(selectPrimaryName(undefined)).toBeUndefined();
  });
});

describe('isInbound', () => {
  it('returns true for boolean true', () => {
    expect(isInbound(true)).toBe(true);
  });

  it('returns false for boolean false', () => {
    expect(isInbound(false)).toBe(false);
  });

  it('returns true for the string "true"', () => {
    expect(isInbound('true')).toBe(true);
  });

  it('is case-insensitive on string values', () => {
    expect(isInbound('TRUE')).toBe(true);
    expect(isInbound('True')).toBe(true);
  });

  it('returns false for any other string', () => {
    expect(isInbound('false')).toBe(false);
    expect(isInbound('1')).toBe(false);
    expect(isInbound('')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isInbound(undefined)).toBe(false);
  });
});

describe('getOutboundExpansionIds', () => {
  it('returns expansion link ids without inbound flag', () => {
    const thing: Pick<BggThing, 'links'> = {
      links: [
        { type: BggLinkType.BoardGameExpansion, id: 100, value: 'A' },
        { type: BggLinkType.BoardGameExpansion, id: 101, value: 'B' },
      ],
    };

    expect(getOutboundExpansionIds(thing)).toEqual([100, 101]);
  });

  it('excludes inbound expansion links (the thing IS-an-expansion-of)', () => {
    const thing: Pick<BggThing, 'links'> = {
      links: [
        { type: BggLinkType.BoardGameExpansion, id: 13, value: 'Catan', inbound: true },
        { type: BggLinkType.BoardGameExpansion, id: 200, value: 'Outbound' },
      ],
    };

    expect(getOutboundExpansionIds(thing)).toEqual([200]);
  });

  it('treats the string "true" as inbound (XML→JSON conversion variance)', () => {
    const thing: Pick<BggThing, 'links'> = {
      links: [
        { type: BggLinkType.BoardGameExpansion, id: 13, value: 'Parent', inbound: 'true' },
        { type: BggLinkType.BoardGameExpansion, id: 200, value: 'Real Expansion' },
      ],
    };

    expect(getOutboundExpansionIds(thing)).toEqual([200]);
  });

  it('ignores links of unrelated types', () => {
    const thing: Pick<BggThing, 'links'> = {
      links: [
        { type: BggLinkType.BoardGameDesigner, id: 11, value: 'Designer' },
        { type: BggLinkType.BoardGameMechanic, id: 22, value: 'Mechanic' },
        { type: BggLinkType.BoardGameExpansion, id: 200, value: 'Expansion' },
      ],
    };

    expect(getOutboundExpansionIds(thing)).toEqual([200]);
  });

  it('returns an empty array when there are no links', () => {
    expect(getOutboundExpansionIds({ links: undefined })).toEqual([]);
    expect(getOutboundExpansionIds({ links: [] })).toEqual([]);
  });

  it('returns an empty array when the thing has only inbound expansion links', () => {
    const thing: Pick<BggThing, 'links'> = {
      links: [{ type: BggLinkType.BoardGameExpansion, id: 13, value: 'Parent', inbound: true }],
    };

    expect(getOutboundExpansionIds(thing)).toEqual([]);
  });
});

describe('searchItemToGameSearchData', () => {
  it('maps the basic identity fields', () => {
    const item: BggSearchItem = {
      id: 174430,
      type: BggThingType.BoardGame,
      name: 'Gloomhaven',
      yearpublished: 2017,
    };

    const result = searchItemToGameSearchData(item);

    expect(result.externalId).toBe('174430');
    expect(result.title).toBe('Gloomhaven');
    expect(result.yearPublished).toBe(2017);
  });

  it('maps boardgame type to BASE_GAME content type', () => {
    const result = searchItemToGameSearchData({ id: 1, type: BggThingType.BoardGame, name: 'Catan' });

    expect(result.contentType).toBe(proto.ContentType.CONTENT_TYPE_BASE_GAME);
  });

  it('maps boardgameexpansion type to EXPANSION content type', () => {
    const result = searchItemToGameSearchData({ id: 2, type: BggThingType.BoardGameExpansion, name: 'Seafarers' });

    expect(result.contentType).toBe(proto.ContentType.CONTENT_TYPE_EXPANSION);
  });

  it('maps unknown type to UNSPECIFIED content type', () => {
    const result = searchItemToGameSearchData({ id: 3, type: 'unknown-type', name: 'Mystery' });

    expect(result.contentType).toBe(proto.ContentType.CONTENT_TYPE_UNSPECIFIED);
  });

  it('builds a /boardgame/ source URL for boardgames', () => {
    const result = searchItemToGameSearchData({ id: 174430, type: BggThingType.BoardGame, name: 'Gloomhaven' });

    expect(result.sourceUrl).toBe('https://boardgamegeek.com/boardgame/174430');
  });

  it('builds a /boardgameexpansion/ source URL for expansions', () => {
    const result = searchItemToGameSearchData({ id: 11, type: BggThingType.BoardGameExpansion, name: 'Seafarers' });

    expect(result.sourceUrl).toBe('https://boardgamegeek.com/boardgameexpansion/11');
  });

  it('uses the names array when name is absent', () => {
    const result = searchItemToGameSearchData({
      id: 1,
      type: BggThingType.BoardGame,
      names: [{ type: BggNameType.Primary, value: 'From Names' }],
    });

    expect(result.title).toBe('From Names');
  });

  it('returns an empty title when no name is available', () => {
    const result = searchItemToGameSearchData({ id: 1, type: BggThingType.BoardGame });

    expect(result.title).toBe('');
  });

  it('always includes a Tabletop platform chip', () => {
    const result = searchItemToGameSearchData({ id: 1, type: BggThingType.BoardGame, name: 'Catan' });

    expect(result.availablePlatforms).toHaveLength(1);
    expect(result.availablePlatforms[0].platformType).toBe(proto.PlatformType.PLATFORM_TYPE_TABLETOP);
  });

  it('does not populate availableReleases — search results are too lean', () => {
    const result = searchItemToGameSearchData({ id: 1, type: BggThingType.BoardGame, name: 'Catan' });

    expect(result.availableReleases).toEqual([]);
  });
});

describe('thingToGameSearchData — synthetic release', () => {
  it('emits a single default-edition Tabletop release with the year as the release date', () => {
    const result = thingToGameSearchData(makeBggThing({ id: 174430, yearpublished: 2017 }));

    expect(result.availableReleases).toHaveLength(1);
    expect(result.availableReleases[0].externalId).toBe(DEFAULT_EDITION_KEY);
    expect(result.availableReleases[0].releaseDate).toBe('2017-01-01');
    expect(result.availableReleases[0].platform?.platformType).toBe(proto.PlatformType.PLATFORM_TYPE_TABLETOP);
  });

  it('omits releaseDate when yearpublished is absent', () => {
    const result = thingToGameSearchData(makeBggThing({ yearpublished: undefined }));

    expect(result.availableReleases[0].releaseDate).toBeUndefined();
  });

  it('omits edition fields in search context', () => {
    const result = thingToGameSearchData(makeBggThing({ yearpublished: 2017 }));

    expect(result.availableReleases[0].editionName).toBeUndefined();
    expect(result.availableReleases[0].releaseYear).toBeUndefined();
    expect(result.availableReleases[0].parentEditionExternalId).toBeUndefined();
  });

  it('uses flattened thing.name when names array is absent', () => {
    const result = thingToGameSearchData(makeBggThing({ names: undefined, name: 'Catan' }));

    expect(result.title).toBe('Catan');
  });
});

describe('thingToGameData — synthetic default release (no versions)', () => {
  it('emits a single Tabletop platform with the default-edition synthetic release', () => {
    const result = thingToGameData(makeBggThing({ id: 174430, yearpublished: 2017 }));

    expect(result.platforms).toHaveLength(1);
    expect(result.platforms[0].platformType).toBe(proto.PlatformType.PLATFORM_TYPE_TABLETOP);
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0].externalId).toBe(DEFAULT_EDITION_KEY);
    expect(result.releases[0].releaseDate).toBe('2017-01-01');
    expect(result.releases[0].editionName).toBeUndefined();
  });

  it('omits releaseDate when yearpublished is the BGG sentinel zero', () => {
    const result = thingToGameData(makeBggThing({ yearpublished: 0 }));

    expect(result.releases[0].releaseDate).toBeUndefined();
  });

  it('omits releaseDate when yearpublished is undefined', () => {
    const result = thingToGameData(makeBggThing({ yearpublished: undefined }));

    expect(result.releases[0].releaseDate).toBeUndefined();
  });

  it('uses flattened thing.name when names array is absent', () => {
    const result = thingToGameData(makeBggThing({ names: undefined, name: 'Catan' }));

    expect(result.title).toBe('Catan');
  });

  it('falls back to alternateNames when neither name nor names is present', () => {
    const result = thingToGameData(
      makeBggThing({
        names: undefined,
        name: undefined,
        alternateNames: ['Catane', 'Die Siedler von Catan'],
      }),
    );

    expect(result.title).toBe('Catane');
  });
});

describe('thingToGameData — version-driven releases', () => {
  it('emits one release per BGG version when versions are present', () => {
    const thing = makeBggThing({
      versions: [
        makeBggVersion({ id: 1, name: 'First Edition', yearpublished: 1995, languageNames: ['English'] }),
        makeBggVersion({ id: 2, name: 'Afrikaans edition', yearpublished: 0, languageNames: ['Afrikaans'] }),
      ],
    });

    const result = thingToGameData(thing);

    expect(result.releases).toHaveLength(2);
    expect(result.releases.map((r) => r.externalId)).toEqual(['1', '2']);
    expect(result.releases[0].editionName).toBe('First Edition');
    expect(result.releases[1].editionName).toBe('Afrikaans edition');
  });

  it('coerces BGG sentinel zero on yearpublished to undefined releaseYear', () => {
    const thing = makeBggThing({
      versions: [makeBggVersion({ id: 1, yearpublished: 0 })],
    });

    expect(thingToGameData(thing).releases[0].releaseYear).toBeUndefined();
    expect(thingToGameData(thing).releases[0].releaseDate).toBeUndefined();
  });

  it('populates releaseYear and releaseDate from a known yearpublished', () => {
    const thing = makeBggThing({
      versions: [makeBggVersion({ id: 1, yearpublished: 1995 })],
    });

    const release = thingToGameData(thing).releases[0];
    expect(release.releaseYear).toBe(1995);
    expect(release.releaseDate).toBe('1995-01-01');
  });

  it("extracts languages from a version's language links", () => {
    const thing = makeBggThing({
      versions: [makeBggVersion({ id: 1, languageNames: ['English', 'German'] })],
    });

    const release = thingToGameData(thing).releases[0];
    expect(release.languages.map((l) => l.iso6393)).toEqual(['eng', 'deu']);
  });

  it('drops unrecognized language link values', () => {
    const thing = makeBggThing({
      versions: [makeBggVersion({ id: 1, languageNames: ['English', 'Klingon'] })],
    });

    expect(thingToGameData(thing).releases[0].languages.map((l) => l.iso6393)).toEqual(['eng']);
  });

  it('leaves parentEditionExternalId undefined for all BGG releases', () => {
    const thing = makeBggThing({
      versions: [makeBggVersion({ id: 1 }), makeBggVersion({ id: 2 })],
    });

    expect(thingToGameData(thing).releases.every((r) => r.parentEditionExternalId === undefined)).toBe(true);
  });

  it("does not populate edition-level overrides (BGG versions don't expose them)", () => {
    const thing = makeBggThing({
      versions: [makeBggVersion({ id: 1 })],
    });

    const release = thingToGameData(thing).releases[0];
    expect(release.minPlayers).toBeUndefined();
    expect(release.maxPlayers).toBeUndefined();
    expect(release.minPlaytime).toBeUndefined();
    expect(release.maxPlaytime).toBeUndefined();
  });

  it('falls back to the synthetic default release when versions array is empty', () => {
    const thing = makeBggThing({ versions: [], yearpublished: 2017 });

    const releases = thingToGameData(thing).releases;
    expect(releases).toHaveLength(1);
    expect(releases[0].externalId).toBe(DEFAULT_EDITION_KEY);
  });
});

/**
 * Typed factory functions for building test fixtures. Defaults emit
 * minimally-valid records; pass overrides for the fields under test.
 */

export function makeBggThing(overrides: Partial<BggThing> = {}): BggThing {
  return {
    id: 174430,
    type: BggThingType.BoardGame,
    names: [{ type: BggNameType.Primary, value: 'Gloomhaven' }],
    yearpublished: 2017,
    minplayers: 1,
    maxplayers: 4,
    playingtime: 120,
    minage: 12,
    ...overrides,
  } as BggThing;
}

export function makeBggSearchItem(overrides: Partial<BggSearchItem> = {}): BggSearchItem {
  return {
    id: 174430,
    type: BggThingType.BoardGame,
    name: 'Gloomhaven',
    yearpublished: 2017,
    ...overrides,
  };
}

export function makeBggName(overrides: Partial<BggName> = {}): BggName {
  return {
    type: BggNameType.Primary,
    value: 'Test Game',
    ...overrides,
  };
}

export function makeBggLink(overrides: Partial<BggLink> = {}): BggLink {
  return {
    type: BggLinkType.BoardGameCategory,
    id: 1,
    value: 'Test',
    ...overrides,
  };
}

export function makeBggVersion(
  overrides: Partial<BggVersion> & { languageNames?: readonly string[]; publisherName?: string } = {},
): BggVersion {
  const { languageNames = [], publisherName, ...rest } = overrides;

  const links: BggLink[] = [];

  if (publisherName !== undefined) {
    links.push({
      type: BggLinkType.BoardGamePublisher,
      id: 31418,
      value: publisherName,
    });
  }

  for (const [index, value] of languageNames.entries()) {
    links.push({
      type: BggLinkType.Language,
      id: 2000 + index,
      value,
    });
  }

  return {
    id: 100,
    type: BggThingType.BoardGame,
    name: 'Test Edition',
    yearpublished: 2000,
    productcode: '',
    width: 0,
    length: 0,
    depth: 0,
    weight: 0,
    links,
    ...rest,
  };
}
