import * as proto from '@boardgamesempire/proto-gateway';
import { GameType, PlatformType, Region } from '../constants';
import type { IgdbGame } from '../types';
import { toGameData, toSearchNarrowing } from './game.mapper';

// The proto GameReleaseData.release_date field is contractually an ISO 8601 date
// string ("2007-09-25"). Assert shape rather than an exact value so the tests
// stay stable regardless of the host timezone (toIsoDate is zone-dependent).
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
  });
});
