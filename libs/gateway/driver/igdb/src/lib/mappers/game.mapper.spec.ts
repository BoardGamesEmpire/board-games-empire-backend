import * as proto from '@boardgamesempire/proto-gateway';
import { GameType, PlatformType, Region } from '../constants';
import type { IgdbGame } from '../types';
import { toGameData, toGameSearchData, toSearchNarrowing, utcYearStart } from './game.mapper';

// The proto GameReleaseData.release_date field is contractually an ISO 8601 date
// string ("2007-09-25"). These tests assert its shape. The exact date, read in
// UTC, is held under "publish year" below (#719).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe('game.mapper', () => {
  describe('release dates (proto ISO 8601 contract)', () => {
    it('emits a precise unix date as an ISO 8601 string', () => {
      const game: IgdbGame = {
        id: 1,
        name: 'Released Game',
        release_dates: [
          {
            id: 10,
            platform: { id: 6, name: 'PC', platform_type: PlatformType.Computer },
            date: 1600000000,
            region: Region.NorthAmerica,
          },
        ],
      };

      const [release] = toGameData(game).releases;

      expect(release.releaseDate).toMatch(ISO_DATE);
      // Regression guard for the downstream toReleaseDate(new Date(iso)) contract.
      expect(Number.isNaN(new Date(release.releaseDate as string).getTime())).toBe(false);
      expect(release.localizations[0].releaseDate).toMatch(ISO_DATE);
    });

    it('drops the free-form human date instead of emitting a non-ISO string', () => {
      // IGDB returns only `human` for TBD/quarterly dates. Emitting it verbatim
      // produced an Invalid Date downstream and failed the whole import.
      const game: IgdbGame = {
        id: 2,
        name: 'Upcoming Game',
        release_dates: [
          {
            id: 20,
            platform: { id: 6, name: 'PC', platform_type: PlatformType.Computer },
            human: '2020 Q3',
            region: Region.NorthAmerica,
          },
        ],
      };

      const [release] = toGameData(game).releases;

      expect(release.releaseDate).toBeUndefined();
      expect(release.localizations[0].releaseDate).toBeUndefined();
    });

    it('keeps the precise date even when other entries only have human dates', () => {
      const game: IgdbGame = {
        id: 3,
        name: 'Mixed Game',
        release_dates: [
          {
            id: 30,
            platform: { id: 6, name: 'PC', platform_type: PlatformType.Computer },
            human: 'TBD',
            region: Region.Europe,
          },
          {
            id: 31,
            platform: { id: 6, name: 'PC', platform_type: PlatformType.Computer },
            date: 1600000000,
            region: Region.NorthAmerica,
          },
        ],
      };

      const [release] = toGameData(game).releases;

      // Both entries share a platform, so they collapse into one release whose
      // primary (earliest precise) date wins; the human-only localization is
      // dropped rather than corrupting the payload.
      expect(release.releaseDate).toMatch(ISO_DATE);
      const europe = release.localizations.find((l) => l.region?.regionCode === 'eu');
      expect(europe?.releaseDate).toBeUndefined();
    });
  });

  describe('toSearchNarrowing', () => {
    const filter = (overrides: Partial<proto.SearchFilter>): proto.SearchFilter => ({
      platformTypes: [],
      contentTypes: [],
      ...overrides,
    });

    it('narrows nothing for a search without a filter, or with empty lists', () => {
      expect(toSearchNarrowing(undefined)).toEqual({});
      expect(toSearchNarrowing(filter({}))).toEqual({});
    });

    it('asks for every game type a content type maps from', () => {
      expect(toSearchNarrowing(filter({ contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME] }))).toEqual({
        gameTypes: [GameType.MainGame, GameType.Fork],
      });
      expect(toSearchNarrowing(filter({ contentTypes: [proto.ContentType.CONTENT_TYPE_DLC] }))).toEqual({
        gameTypes: [GameType.DLC, GameType.Episode, GameType.PackAddon],
      });
    });

    it('asks for the platform types each platform type maps from, operating systems and computers for mobile', () => {
      expect(
        toSearchNarrowing(
          filter({
            platformTypes: [proto.PlatformType.PLATFORM_TYPE_PORTABLE, proto.PlatformType.PLATFORM_TYPE_CONSOLE],
          }),
        ),
      ).toEqual({ platformTypes: [PlatformType.Console, PlatformType.PortableConsole] });
      expect(toSearchNarrowing(filter({ platformTypes: [proto.PlatformType.PLATFORM_TYPE_MOBILE] }))).toEqual({
        platformTypes: [PlatformType.OperatingSystem, PlatformType.Computer],
      });
    });

    it('leaves platform types unnarrowed when the filter names other, which stands for types IGDB can’t be asked for', () => {
      expect(
        toSearchNarrowing(
          filter({
            platformTypes: [proto.PlatformType.PLATFORM_TYPE_OTHER, proto.PlatformType.PLATFORM_TYPE_PC],
            contentTypes: [proto.ContentType.CONTENT_TYPE_MOD],
          }),
        ),
      ).toEqual({ gameTypes: [GameType.Mod] });
    });

    it('answers null when an axis names nothing IGDB has, so IGDB isn’t asked', () => {
      expect(toSearchNarrowing(filter({ platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP] }))).toBeNull();
      expect(toSearchNarrowing(filter({ contentTypes: [proto.ContentType.CONTENT_TYPE_ACCESSORY] }))).toBeNull();
    });

    // IGDB dates a game by its first release, in Unix seconds, and a year is
    // read in UTC, so the narrowing agrees with the year each result is sent
    // with (#719).
    it('narrows to games released from the minimum’s first day up to the day after the maximum’s last', () => {
      expect(toSearchNarrowing(filter({ publishYear: { min: 1990, max: 1999 } }))).toEqual({
        releasedBetween: { from: 631152000, before: 946684800, orUnknown: false },
      });
    });

    it('narrows by one bound alone, and keeps undated games when the range includes unknown ones', () => {
      expect(toSearchNarrowing(filter({ publishYear: { max: 1999, includeUnknown: true } }))).toEqual({
        releasedBetween: { before: 946684800, orUnknown: true },
      });
    });

    it('narrows nothing by a range with no bound', () => {
      expect(toSearchNarrowing(filter({ publishYear: { includeUnknown: true } }))).toEqual({});
    });

    // A Date holds about 275,000 years either side of 1970. A bound past that
    // narrows nothing on its side, and the server still removes what it excludes.
    it('leaves out a bound no date can reach', () => {
      expect(toSearchNarrowing(filter({ publishYear: { min: 1990, max: 300_000 } }))).toEqual({
        releasedBetween: { from: 631152000, orUnknown: false },
      });
      expect(toSearchNarrowing(filter({ publishYear: { min: 300_000 } }))).toEqual({});
    });
  });

  describe('publish year (#719)', () => {
    /** Runs `read` with the process in `zone`, as a server outside UTC is. */
    const inZone = <T>(zone: string, read: () => T): T => {
      const previous = process.env['TZ'];
      process.env['TZ'] = zone;
      try {
        return read();
      } finally {
        if (previous === undefined) {
          delete process.env['TZ'];
        } else {
          process.env['TZ'] = previous;
        }
      }
    };

    const firstReleased = (first_release_date: number): IgdbGame => ({ id: 1, name: 'G', first_release_date });

    it('reads a first release date’s year in UTC', () => {
      // 2020-01-01T00:00:00Z is still 2019 in Los Angeles, and 2019-12-31T23:59:59Z is already 2020 in Tokyo.
      expect(inZone('America/Los_Angeles', () => toGameSearchData(firstReleased(1577836800)).yearPublished)).toBe(2020);
      expect(inZone('Asia/Tokyo', () => toGameSearchData(firstReleased(1577836799)).yearPublished)).toBe(2019);
      expect(inZone('America/Los_Angeles', () => toGameData(firstReleased(1577836800)).yearPublished)).toBe(2020);
    });

    it('dates a release in UTC, so its date and its year agree', () => {
      const game: IgdbGame = {
        id: 1,
        name: 'G',
        release_dates: [
          {
            id: 10,
            platform: { id: 6, name: 'PC', platform_type: PlatformType.Computer },
            date: 1577836800,
            region: Region.NorthAmerica,
          },
        ],
      };

      const [release] = inZone('America/Los_Angeles', () => toGameData(game).releases);

      expect(release.releaseYear).toBe(2020);
      expect(release.releaseDate).toBe('2020-01-01');
      expect(release.localizations[0].releaseDate).toBe('2020-01-01');
    });

    // Date.UTC reads a year from 0 to 99 as 1900 plus it.
    it('takes years before 100 as written', () => {
      expect(utcYearStart(50)).toBe(-60589296000);
      expect(utcYearStart(2000)).toBe(946684800);
      expect(utcYearStart(-500)).toBe(-77945673600);
    });
  });
});
