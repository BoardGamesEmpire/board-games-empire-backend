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

describe('the player-count and play-time filters on the api (#869)', () => {
  /** A game whose play time `fitsUpTo` keeps: its own time, or its only one, within the bound. */
  const fitsUpTo = (max: number) => ({
    OR: [{ maxPlayTime: { lte: max } }, { maxPlayTime: null, minPlayTime: { lte: max } }],
  });

  /** A game whose play time `fitsFrom` keeps: its own time, or its only one, from the bound. */
  const fitsFrom = (min: number) => ({
    OR: [{ minPlayTime: { gte: min } }, { minPlayTime: null, maxPlayTime: { gte: min } }],
  });

  describe('toProtoSearchFilter', () => {
    it('sends a player-count range, and no play time when none is given', () => {
      const filter = toProtoSearchFilter({ playerCountMin: 3, playerCountMax: 5 });

      expect(filter).toEqual({ platformTypes: [], contentTypes: [], playerCount: { min: 3, max: 5 } });
      expect(filter).not.toHaveProperty('playTime');
    });

    // The coordinator reads a single player-count bound as one count, so
    // the api sends it as given rather than as a range of its own.
    it('sends a single player-count bound as given', () => {
      expect(toProtoSearchFilter({ playerCountMin: 5 })?.playerCount).toEqual({ min: 5 });
    });

    it('sends a play-time range in minutes, 0 included, and include unknown only when set', () => {
      expect(toProtoSearchFilter({ playTimeMin: 0, playTimeMax: 90, playTimeIncludeUnknown: true })?.playTime).toEqual({
        min: 0,
        max: 90,
        includeUnknown: true,
      });
      expect(toProtoSearchFilter({ playTimeMax: 90, playTimeIncludeUnknown: false })?.playTime).toEqual({ max: 90 });
    });

    it('sends nothing when only include unknown is set, since it alone narrows nothing', () => {
      expect(toProtoSearchFilter({ playTimeIncludeUnknown: true })).toBeUndefined();
      expect(toProtoSearchFilter({ playerCountIncludeUnknown: true, playerCountMin: null })).toBeUndefined();
    });
  });

  describe('localFilterConditions', () => {
    // A single bound is one count: a 2–4 game fails `maxPlayers >= 5`, a 2–6
    // game passes both. A null count fails either comparison, so a game
    // missing one is never matched as known.
    it('reads playerCountMin=5 alone as games that support 5 players', () => {
      expect(localFilterConditions({ playerCountMin: 5 })).toEqual([
        { minPlayers: { lte: 5 }, maxPlayers: { gte: 5 } },
      ]);
    });

    it('keeps only games that support every player count in the range', () => {
      expect(localFilterConditions({ playerCountMin: 3, playerCountMax: 5 })).toEqual([
        { minPlayers: { lte: 3 }, maxPlayers: { gte: 5 } },
      ]);
    });

    it('keeps games missing either player count when the range includes unknown ones', () => {
      expect(localFilterConditions({ playerCountMax: 4, playerCountIncludeUnknown: true })).toEqual([
        {
          OR: [
            { minPlayers: { lte: 4 }, maxPlayers: { gte: 4 } },
            { OR: [{ minPlayers: null }, { maxPlayers: null }] },
          ],
        },
      ]);
    });

    // A game with only a minimum of 60 is a 60-minute game: the second arm
    // keeps it under playTimeMax=90 and drops it under playTimeMax=45.
    it('reads a game with one play time as that time, and keeps games with none when unknown ones are included', () => {
      expect(localFilterConditions({ playTimeMax: 90, playTimeIncludeUnknown: true })).toEqual([
        { OR: [fitsUpTo(90), { minPlayTime: null, maxPlayTime: null }] },
      ]);
    });

    it('narrows only the side a play-time bound is given for', () => {
      expect(localFilterConditions({ playTimeMin: 45 })).toEqual([fitsFrom(45)]);
      expect(localFilterConditions({ playTimeMax: 90 })).toEqual([fitsUpTo(90)]);
    });

    it('keeps only games whose whole play time fits a range with both bounds', () => {
      expect(localFilterConditions({ playTimeMin: 30, playTimeMax: 90 })).toEqual([
        { AND: [fitsFrom(30), fitsUpTo(90)] },
      ]);
    });

    it('adds one condition for each filter given', () => {
      expect(localFilterConditions({ publishYearMin: 1990, playerCountMin: 2, playTimeMax: 60 })).toEqual([
        { publishYear: { gte: 1990 } },
        { minPlayers: { lte: 2 }, maxPlayers: { gte: 2 } },
        fitsUpTo(60),
      ]);
    });

    it('adds no condition when a range has no bound', () => {
      expect(
        localFilterConditions({ playerCountIncludeUnknown: true, playTimeIncludeUnknown: true, playTimeMin: null }),
      ).toEqual([]);
    });
  });
});
