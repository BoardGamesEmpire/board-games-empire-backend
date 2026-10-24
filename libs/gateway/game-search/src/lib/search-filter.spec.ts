import { SearchFilterAxis } from '@bge/database';
import * as proto from '@boardgamesempire/proto-gateway';
import { filterFor, matchesFilter, toResultFilter } from './search-filter';

const game = (yearPublished?: number): proto.GameSearchData => ({
  externalId: 'g',
  title: 'G',
  contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  yearPublished,
  availablePlatforms: [],
  availableReleases: [],
});

const range = (publishYear: proto.IntRange) => toResultFilter({ platformTypes: [], contentTypes: [], publishYear });

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
