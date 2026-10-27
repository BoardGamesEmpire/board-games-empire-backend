import { SearchFilterAxis } from '@bge/database';
import * as proto from '@boardgamesempire/proto-gateway';
import { filterFor, matchesFilter, toResultFilter, unfilterableAxes } from './search-filter';

const game = (yearPublished?: number): proto.GameSearchData => ({
  externalId: 'g',
  title: 'G',
  contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  yearPublished,
  availablePlatforms: [],
  availableReleases: [],
});

const range = (publishYear: proto.IntRange) => toResultFilter({ platformTypes: [], contentTypes: [], publishYear });

/** A game for `minPlayers` to `maxPlayers` players, either of which may be missing. */
const forPlayers = (minPlayers?: number, maxPlayers?: number): proto.GameSearchData => ({
  ...game(),
  minPlayers,
  maxPlayers,
});

/** A game that plays in `minPlaytime` to `maxPlaytime` minutes, either of which may be missing. */
const playing = (minPlaytime?: number, maxPlaytime?: number): proto.GameSearchData => ({
  ...game(),
  minPlaytime,
  maxPlaytime,
});

const players = (playerCount: proto.IntRange) => toResultFilter({ platformTypes: [], contentTypes: [], playerCount });

const minutes = (playTime: proto.IntRange) => toResultFilter({ platformTypes: [], contentTypes: [], playTime });

/** What the gRPC loader can hand over for an unset field. */
const unset = null as unknown as undefined;

describe('the publish-year filter (#719)', () => {
  it('keeps a game whose publish year is within the range, both bounds inclusive', () => {
    const nineties = range({ min: 1990, max: 2000 });

    expect([1990, 1995, 2000].map((year) => matchesFilter(game(year), nineties))).toEqual([true, true, true]);
    expect([1989, 2001].map((year) => matchesFilter(game(year), nineties))).toEqual([false, false]);
  });

  it('narrows by one bound alone, and takes negative years', () => {
    expect(matchesFilter(game(-2200), range({ max: 0 }))).toBe(true);
    expect(matchesFilter(game(-2200), range({ min: 1 }))).toBe(false);
    expect(matchesFilter(game(2024), range({ min: 1 }))).toBe(true);
  });

  it('drops a game with no publish year unless the range includes unknown ones', () => {
    expect(matchesFilter(game(undefined), range({ min: 1990 }))).toBe(false);
    expect(matchesFilter(game(undefined), range({ min: 1990, includeUnknown: false }))).toBe(false);
    expect(matchesFilter(game(undefined), range({ min: 1990, includeUnknown: true }))).toBe(true);
  });

  it('still drops a dated game outside the range when it includes unknown ones', () => {
    expect(matchesFilter(game(1989), range({ min: 1990, includeUnknown: true }))).toBe(false);
  });

  it('reads a range with no bound as no year filter, whatever it says of unknown ones', () => {
    const filter = toResultFilter({ platformTypes: [], contentTypes: [], publishYear: { includeUnknown: true } });

    expect(filter.publishYear).toBeUndefined();
    expect(matchesFilter(game(undefined), filter)).toBe(true);
  });

  it('sends the publish year only to a DataGateway that narrows by it', () => {
    const filter = { platformTypes: [], contentTypes: [], publishYear: { min: 1990, includeUnknown: false } };

    expect(filterFor(filter, [SearchFilterAxis.PublishYear])).toEqual({
      platformTypes: [],
      contentTypes: [],
      publishYear: { min: 1990 },
    });
    expect(filterFor(filter, [SearchFilterAxis.ContentType])).toBeUndefined();
  });

  it('sends a range that keeps unknown years as it is, and none with no bound', () => {
    const axes = [SearchFilterAxis.PublishYear];

    expect(
      filterFor({ platformTypes: [], contentTypes: [], publishYear: { max: 2000, includeUnknown: true } }, axes),
    ).toEqual({ platformTypes: [], contentTypes: [], publishYear: { max: 2000, includeUnknown: true } });
    expect(
      filterFor({ platformTypes: [], contentTypes: [], publishYear: { includeUnknown: true } }, axes),
    ).toBeUndefined();
  });
});

// A game night's range is everyone who might come, so a game must support
// every count in it, not just one of them (#869).
describe('the player-count filter (#869)', () => {
  it('keeps a game that supports every count in the range', () => {
    expect(matchesFilter(forPlayers(2, 6), players({ min: 3, max: 5 }))).toBe(true);
    expect(matchesFilter(forPlayers(2, 4), players({ min: 3, max: 5 }))).toBe(false);
  });

  it('reads one bound alone as one count', () => {
    expect(matchesFilter(forPlayers(2, 6), players({ min: 5 }))).toBe(true);
    expect(matchesFilter(forPlayers(2, 4), players({ min: 5 }))).toBe(false);
    expect(matchesFilter(forPlayers(6, 8), players({ min: 5 }))).toBe(false);
    expect(matchesFilter(forPlayers(2, 4), players({ max: 2 }))).toBe(true);
    expect(matchesFilter(forPlayers(3, 5), players({ max: 2 }))).toBe(false);
    expect(matchesFilter(forPlayers(1, 1), players({ max: 2 }))).toBe(false);
  });

  it('treats a game missing either count as unknown', () => {
    expect(matchesFilter(forPlayers(2), players({ min: 2 }))).toBe(false);
    expect(matchesFilter(forPlayers(undefined, 4), players({ max: 4 }))).toBe(false);
    expect(matchesFilter(forPlayers(2), players({ min: 2, includeUnknown: true }))).toBe(true);
  });

  it('still drops a game whose counts miss the range when it keeps unknown ones', () => {
    expect(matchesFilter(forPlayers(2, 4), players({ min: 5, includeUnknown: true }))).toBe(false);
  });

  it('reads a count the gRPC loader sent as null as missing', () => {
    expect(matchesFilter(forPlayers(unset, 6), players({ min: 2 }))).toBe(false);
  });
});

// A play time has to fit the time there is, so a game's whole play time lies
// within the range, and a bound left out doesn't narrow that side (#869).
describe('the play-time filter (#869)', () => {
  it('keeps a game whose whole play time fits the range', () => {
    expect(matchesFilter(playing(30, 60), minutes({ max: 60 }))).toBe(true);
    expect(matchesFilter(playing(30, 60), minutes({ min: 30, max: 90 }))).toBe(true);
    expect(matchesFilter(playing(30, 120), minutes({ max: 60 }))).toBe(false);
  });

  it('reads a game with one time as that time at both ends', () => {
    expect(matchesFilter(playing(60), minutes({ max: 90 }))).toBe(true);
    expect(matchesFilter(playing(60), minutes({ max: 45 }))).toBe(false);
    expect(matchesFilter(playing(undefined, 60), minutes({ min: 75 }))).toBe(false);
  });

  it('drops a game with no play time unless the range keeps unknown ones', () => {
    expect(matchesFilter(playing(), minutes({ max: 90 }))).toBe(false);
    expect(matchesFilter(playing(), minutes({ max: 90, includeUnknown: true }))).toBe(true);
    expect(matchesFilter(playing(30, 120), minutes({ max: 90, includeUnknown: true }))).toBe(false);
  });

  it('reads a time the gRPC loader sent as null as missing', () => {
    expect(matchesFilter(playing(unset, 60), minutes({ min: 30 }))).toBe(true);
    expect(matchesFilter(playing(unset, unset), minutes({ max: 90 }))).toBe(false);
  });
});

// Neither range is coverage. Declaring one promises that a DataGateway's
// results carry the value and that its search narrows by it, so without it a
// search that keeps no unknown values can't count on any result passing (#869).
describe("the filters a DataGateway can't apply (#869)", () => {
  it('sends player count and play time only to a DataGateway that declares each', () => {
    const filter: proto.SearchFilter = {
      platformTypes: [],
      contentTypes: [],
      playerCount: { min: 4, includeUnknown: false },
      playTime: { max: 60, includeUnknown: true },
    };

    expect(filterFor(filter, [SearchFilterAxis.PlayerCount])).toEqual({
      platformTypes: [],
      contentTypes: [],
      playerCount: { min: 4, max: 4 },
    });
    expect(filterFor(filter, [SearchFilterAxis.PlayTime])).toEqual({
      platformTypes: [],
      contentTypes: [],
      playTime: { max: 60, includeUnknown: true },
    });
    expect(filterFor(filter, [SearchFilterAxis.PublishYear])).toBeUndefined();
  });

  // A bound alone is one count, so the ways of writing one count are one
  // search: sent alike, they key one cache entry and cost one upstream call.
  // A play time's missing bound doesn't narrow, so it stays missing (#869).
  it('sends a player count given by one bound as both bounds, and a play time as given', () => {
    const axes = [SearchFilterAxis.PlayerCount, SearchFilterAxis.PlayTime];
    const sent = (playerCount: proto.IntRange, playTime?: proto.IntRange) =>
      filterFor({ platformTypes: [], contentTypes: [], playerCount, playTime }, axes);

    expect(sent({ min: 5 })?.playerCount).toEqual({ min: 5, max: 5 });
    expect(sent({ max: 5 })?.playerCount).toEqual({ min: 5, max: 5 });
    expect(sent({ min: 5, max: 5 })?.playerCount).toEqual({ min: 5, max: 5 });
    expect(sent({ max: 5, includeUnknown: true })?.playerCount).toEqual({ min: 5, max: 5, includeUnknown: true });
    expect(sent({ min: 3, max: 5 }, { min: 30 })).toEqual({
      platformTypes: [],
      contentTypes: [],
      playerCount: { min: 3, max: 5 },
      playTime: { min: 30 },
    });
  });

  it('names each range a DataGateway does not declare', () => {
    const filter = toResultFilter({
      platformTypes: [],
      contentTypes: [],
      playerCount: { min: 4 },
      playTime: { max: 60 },
    });

    expect(unfilterableAxes(filter, [])).toEqual([SearchFilterAxis.PlayerCount, SearchFilterAxis.PlayTime]);
    expect(unfilterableAxes(filter, [SearchFilterAxis.PlayTime])).toEqual([SearchFilterAxis.PlayerCount]);
    expect(unfilterableAxes(filter, [SearchFilterAxis.PlayerCount, SearchFilterAxis.PlayTime])).toEqual([]);
  });

  it('names none that keeps unknown values', () => {
    const filter = toResultFilter({
      platformTypes: [],
      contentTypes: [],
      playerCount: { min: 4, includeUnknown: true },
      playTime: { max: 60, includeUnknown: true },
    });

    expect(unfilterableAxes(filter, [])).toEqual([]);
  });

  it('names none for a range with no bound', () => {
    const filter = toResultFilter({
      platformTypes: [],
      contentTypes: [],
      playerCount: { includeUnknown: true },
      playTime: { includeUnknown: false },
    });

    expect(unfilterableAxes(filter, [])).toEqual([]);
    expect(matchesFilter(game(), filter)).toBe(true);
  });

  it('never names publish year', () => {
    expect(unfilterableAxes(range({ min: 1990 }), [])).toEqual([]);
  });
});
