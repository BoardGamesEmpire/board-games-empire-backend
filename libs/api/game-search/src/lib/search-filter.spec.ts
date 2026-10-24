import { localFilterConditions, toProtoSearchFilter } from './search-filter';

describe('the publish-year filter on the api (#719)', () => {
  describe('toProtoSearchFilter', () => {
    it('sends the bounds given, and include unknown only when set', () => {
      expect(
        toProtoSearchFilter({ publishYearMin: 1990, publishYearMax: null, publishYearIncludeUnknown: true }),
      ).toEqual({ platformTypes: [], contentTypes: [], publishYear: { min: 1990, includeUnknown: true } });
      expect(toProtoSearchFilter({ publishYearMax: -500, publishYearIncludeUnknown: false })).toEqual({
        platformTypes: [],
        contentTypes: [],
        publishYear: { max: -500 },
      });
    });

    it('sends year 0 as a bound', () => {
      expect(toProtoSearchFilter({ publishYearMin: 0 })?.publishYear).toEqual({ min: 0 });
    });

    it('sends nothing when only include unknown is set, since it alone narrows nothing', () => {
      expect(toProtoSearchFilter({ publishYearIncludeUnknown: true })).toBeUndefined();
      expect(toProtoSearchFilter({ publishYearMin: null, publishYearMax: null })).toBeUndefined();
    });
  });

  describe('localFilterConditions', () => {
    it('narrows the search in the game catalog to the range, both bounds inclusive', () => {
      expect(localFilterConditions({ publishYearMin: 1990, publishYearMax: 2000 })).toEqual([
        { publishYear: { gte: 1990, lte: 2000 } },
      ]);
      expect(localFilterConditions({ publishYearMax: 0 })).toEqual([{ publishYear: { lte: 0 } }]);
    });

    it('keeps games with no publish year when the range includes unknown ones', () => {
      expect(
        localFilterConditions({ publishYearMin: 1990, publishYearMax: 2000, publishYearIncludeUnknown: true }),
      ).toEqual([{ OR: [{ publishYear: { gte: 1990, lte: 2000 } }, { publishYear: null }] }]);
    });

    it('adds no condition when the range has no bound', () => {
      expect(localFilterConditions({ publishYearIncludeUnknown: true, publishYearMin: null })).toEqual([]);
    });
  });
});
