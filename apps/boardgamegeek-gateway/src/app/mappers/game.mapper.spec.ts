import * as proto from '@board-games-empire/proto-gateway';
import { BggLinkType, BggNameType, BggThingType } from '../constants';
import type { BggSearchItem, BggThing } from '../types';
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

describe('thingToGameSearchData', () => {
  it('selects the primary name', () => {
    const thing = baseThing({
      names: [
        { type: BggNameType.Alternate, value: 'Catan (German)' },
        { type: BggNameType.Primary, value: 'Catan' },
      ],
    });

    expect(thingToGameSearchData(thing).title).toBe('Catan');
  });

  it('passes through thumbnail and player counts', () => {
    const thing = baseThing({ thumbnail: 'https://cf.geekdo.com/thumb.jpg', minplayers: 3, maxplayers: 4 });

    const result = thingToGameSearchData(thing);

    expect(result.thumbnailUrl).toBe('https://cf.geekdo.com/thumb.jpg');
    expect(result.minPlayers).toBe(3);
    expect(result.maxPlayers).toBe(4);
  });

  it('extracts averageRating from statistics.ratings', () => {
    const thing = baseThing({ statistics: { ratings: { average: 7.85 } } });

    expect(thingToGameSearchData(thing).averageRating).toBeCloseTo(7.85);
  });

  it('sets baseGameExternalId when an inbound boardgameexpansion link is present', () => {
    const thing = baseThing({
      type: BggThingType.BoardGameExpansion,
      links: [{ type: BggLinkType.BoardGameExpansion, id: 174430, value: 'Gloomhaven', inbound: true }],
    });

    expect(thingToGameSearchData(thing).baseGameExternalId).toBe('174430');
  });

  it('does not set baseGameExternalId for outbound expansion links', () => {
    const thing = baseThing({
      links: [{ type: BggLinkType.BoardGameExpansion, id: 999, value: 'Some Expansion' }],
    });

    expect(thingToGameSearchData(thing).baseGameExternalId).toBeUndefined();
  });

  it('synthesizes a single Tabletop release with the year as the release date', () => {
    const thing = baseThing({ id: 174430, yearpublished: 2017 });

    const result = thingToGameSearchData(thing);

    expect(result.availableReleases).toHaveLength(1);
    expect(result.availableReleases[0].releaseDate).toBe('2017-01-01');
    expect(result.availableReleases[0].externalId).toBe('bgg-174430-tabletop');
    expect(result.availableReleases[0].platform?.platformType).toBe(proto.PlatformType.PLATFORM_TYPE_TABLETOP);
  });

  it('omits releaseDate when yearpublished is absent', () => {
    const thing = baseThing({ id: 1, yearpublished: undefined });

    const result = thingToGameSearchData(thing);

    expect(result.availableReleases[0].releaseDate).toBeUndefined();
  });
});

describe('thingToGameData', () => {
  it('maps the basic identity and descriptive fields', () => {
    const thing = baseThing({
      id: 174430,
      type: BggThingType.BoardGame,
      names: [{ type: BggNameType.Primary, value: 'Gloomhaven' }],
      description: 'A campaign-driven dungeon crawler.',
      thumbnail: 'https://cf.geekdo.com/thumb.jpg',
      image: 'https://cf.geekdo.com/full.jpg',
      yearpublished: 2017,
    });

    const result = thingToGameData(thing);

    expect(result.externalId).toBe('174430');
    expect(result.title).toBe('Gloomhaven');
    expect(result.contentType).toBe(proto.ContentType.CONTENT_TYPE_BASE_GAME);
    expect(result.description).toBe('A campaign-driven dungeon crawler.');
    expect(result.thumbnailUrl).toBe('https://cf.geekdo.com/thumb.jpg');
    expect(result.imageUrl).toBe('https://cf.geekdo.com/full.jpg');
    expect(result.yearPublished).toBe(2017);
  });

  it('extracts ratings statistics', () => {
    const thing = baseThing({
      statistics: {
        ratings: { average: 8.65, bayesaverage: 8.42, usersrated: 50000 },
      },
    });

    const result = thingToGameData(thing);

    expect(result.averageRating).toBeCloseTo(8.65);
    expect(result.bayesRating).toBeCloseTo(8.42);
    expect(result.ratingsCount).toBe(50000);
  });

  it('scales averageweight by 1000 to populate complexityWeight as int32', () => {
    const thing = baseThing({ statistics: { ratings: { averageweight: 3.876 } } });

    expect(thingToGameData(thing).complexityWeight).toBe(3876);
  });

  it('leaves complexityWeight undefined when averageweight is missing', () => {
    const thing = baseThing({ statistics: { ratings: { average: 8.0 } } });

    expect(thingToGameData(thing).complexityWeight).toBeUndefined();
  });

  it('falls back to playingtime for both min and max playtime when explicit values are missing', () => {
    const thing = baseThing({ playingtime: 90 });

    const result = thingToGameData(thing);

    expect(result.minPlaytime).toBe(90);
    expect(result.maxPlaytime).toBe(90);
  });

  it('uses explicit min/maxplaytime when provided', () => {
    const thing = baseThing({ playingtime: 120, minplaytime: 60, maxplaytime: 180 });

    const result = thingToGameData(thing);

    expect(result.minPlaytime).toBe(60);
    expect(result.maxPlaytime).toBe(180);
  });

  it('maps designer links to PersonData', () => {
    const thing = baseThing({
      links: [
        { type: BggLinkType.BoardGameDesigner, id: 1, value: 'Isaac Childres' },
        { type: BggLinkType.BoardGameDesigner, id: 2, value: 'Klaus Teuber' },
      ],
    });

    const result = thingToGameData(thing);

    expect(result.designers).toEqual([
      { externalId: '1', name: 'Isaac Childres' },
      { externalId: '2', name: 'Klaus Teuber' },
    ]);
  });

  it('maps artist, publisher, mechanic, and category links', () => {
    const thing = baseThing({
      links: [
        { type: BggLinkType.BoardGameArtist, id: 10, value: 'Artist A' },
        { type: BggLinkType.BoardGamePublisher, id: 20, value: 'Cephalofair Games' },
        { type: BggLinkType.BoardGameMechanic, id: 30, value: 'Hand Management' },
        { type: BggLinkType.BoardGameCategory, id: 40, value: 'Adventure' },
      ],
    });

    const result = thingToGameData(thing);

    expect(result.artists).toEqual([{ externalId: '10', name: 'Artist A' }]);
    expect(result.publishers).toEqual([{ externalId: '20', name: 'Cephalofair Games' }]);
    expect(result.mechanics).toEqual([{ externalId: '30', name: 'Hand Management' }]);
    expect(result.categories).toEqual([{ externalId: '40', name: 'Adventure' }]);
  });

  it('parses the BGG family-name prefix into familyType', () => {
    const thing = baseThing({
      links: [{ type: BggLinkType.BoardGameFamily, id: 100, value: 'Game: Catan Series' }],
    });

    const result = thingToGameData(thing);

    expect(result.families).toEqual([{ externalId: '100', name: 'Catan Series', familyType: 'Game' }]);
  });

  it('leaves familyType undefined for family names without a prefix', () => {
    const thing = baseThing({
      links: [{ type: BggLinkType.BoardGameFamily, id: 100, value: 'Catan Series' }],
    });

    const result = thingToGameData(thing);

    expect(result.families).toEqual([{ externalId: '100', name: 'Catan Series', familyType: undefined }]);
  });

  it('excludes inbound links from outbound link arrays', () => {
    // Inbound links represent reverse relationships and should never
    // pollute the outbound association arrays.
    const thing = baseThing({
      links: [
        { type: BggLinkType.BoardGameDesigner, id: 1, value: 'Designer' },
        { type: BggLinkType.BoardGameDesigner, id: 2, value: 'Reverse Reference', inbound: true },
      ],
    });

    const result = thingToGameData(thing);

    expect(result.designers).toEqual([{ externalId: '1', name: 'Designer' }]);
  });

  it('derives baseGameExternalId from inbound boardgameexpansion link', () => {
    const thing = baseThing({
      type: BggThingType.BoardGameExpansion,
      links: [{ type: BggLinkType.BoardGameExpansion, id: 174430, value: 'Gloomhaven', inbound: true }],
    });

    expect(thingToGameData(thing).baseGameExternalId).toBe('174430');
  });

  it('sets BGG-irrelevant fields to empty arrays / undefined', () => {
    const result = thingToGameData(baseThing());

    expect(result.themes).toEqual([]);
    expect(result.ageRatings).toEqual([]);
    expect(result.dlc).toEqual([]);
    expect(result.metadataKeys).toEqual([]);
    expect(result.metadataValues).toEqual([]);
    expect(result.summary).toBeUndefined();
  });

  it('always emits a single Tabletop platform with a synthetic release', () => {
    const result = thingToGameData(baseThing({ id: 174430, yearpublished: 2017 }));

    expect(result.platforms).toHaveLength(1);
    expect(result.platforms[0].platformType).toBe(proto.PlatformType.PLATFORM_TYPE_TABLETOP);
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0].externalId).toBe('bgg-174430-tabletop');
    expect(result.releases[0].releaseDate).toBe('2017-01-01');
  });

  it('returns an empty title when no names are present', () => {
    const result = thingToGameData(baseThing({ names: undefined }));

    expect(result.title).toBe('');
  });

  it('handles a thing with no links by returning empty association arrays', () => {
    const result = thingToGameData(baseThing({ links: undefined }));

    expect(result.designers).toEqual([]);
    expect(result.artists).toEqual([]);
    expect(result.publishers).toEqual([]);
    expect(result.mechanics).toEqual([]);
    expect(result.categories).toEqual([]);
    expect(result.families).toEqual([]);
  });
});

function baseThing(overrides: Partial<BggThing> = {}): BggThing {
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
  };
}
