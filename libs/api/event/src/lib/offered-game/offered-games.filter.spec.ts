import { ContentType, GameMedium, PlatformType } from '@bge/database';
import { gameRangeConditions } from '@bge/game-search';
import { plainToInstance } from 'class-transformer';
import { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';
import { offeredGamesFilter } from './offered-games.filter';

const query = (init: Partial<ListOfferedGamesQueryDto>) => plainToInstance(ListOfferedGamesQueryDto, init);

/** The condition `game` names, on an offered entry's game. */
const onGame = (game: object) => ({ collection: { is: { platformGame: { is: { game: { is: game } } } } } });

describe('offeredGamesFilter (#1187)', () => {
  it('narrows nothing without a filter', () => {
    expect(offeredGamesFilter(query({}))).toEqual([]);
  });

  // Search reads a platform type as any platform the game is on. An offered
  // entry is one copy on one platform, and that's the one the filter means.
  it("excludes by the entry's own platform type, not every platform the game is on (#1187)", () => {
    expect(offeredGamesFilter(query({ excludePlatformTypes: [PlatformType.PC, PlatformType.Console] }))).toEqual([
      {
        NOT: {
          collection: {
            is: { platformGame: { is: { platform: { is: { platformType: { in: ['PC', 'Console'] } } } } } },
          },
        },
      },
    ]);
  });

  it('takes an include and an exclude on one facet at once', () => {
    expect(offeredGamesFilter(query({ attendeeIds: ['a', 'b'], excludeAttendeeIds: ['b'] }))).toEqual([
      { attendeeId: { in: ['a', 'b'] } },
      { NOT: { attendeeId: { in: ['b'] } } },
    ]);
  });

  it("filters the entry's medium and its game's content type, each both ways", () => {
    expect(
      offeredGamesFilter(
        query({
          mediums: [GameMedium.Physical],
          excludeMediums: [GameMedium.Digital],
          contentTypes: [ContentType.BaseGame, ContentType.Unknown],
          excludeContentTypes: [ContentType.Expansion],
        }),
      ),
    ).toEqual([
      { collection: { is: { medium: { in: ['Physical'] } } } },
      { NOT: { collection: { is: { medium: { in: ['Digital'] } } } } },
      onGame({ contentType: { in: ['BaseGame', 'Unknown'] } }),
      { NOT: onGame({ contentType: { in: ['Expansion'] } }) },
    ]);
  });

  it("filters an include list of platform types by the entry's platform", () => {
    expect(offeredGamesFilter(query({ platformTypes: [PlatformType.Tabletop] }))).toEqual([
      { collection: { is: { platformGame: { is: { platform: { is: { platformType: { in: ['Tabletop'] } } } } } } } },
    ]);
  });

  // Every term must appear, in either field, and a `%` or `_` in the query
  // is a character to find, never a wildcard.
  it('matches every term in the title or the subtitle, wildcards escaped', () => {
    const term = (escaped: string) =>
      onGame({
        OR: [
          { title: { contains: escaped, mode: 'insensitive' } },
          { subtitle: { contains: escaped, mode: 'insensitive' } },
        ],
      });

    expect(offeredGamesFilter(query({ q: '  catan  100% ' }))).toEqual([term('catan'), term('100\\%')]);
    expect(offeredGamesFilter(query({ q: 'a_b' }))).toEqual([term('a\\_b')]);
  });

  it('narrows nothing for a blank query', () => {
    expect(offeredGamesFilter(query({ q: '   ' }))).toEqual([]);
  });

  it("nests the search range rules under the entry's game", () => {
    expect(offeredGamesFilter(query({ playerCountMin: 4 }))).toEqual([
      onGame(gameRangeConditions({ playerCountMin: 4 })[0]),
    ]);
    expect(offeredGamesFilter(query({ publishYearMax: 2019, playTimeMin: 30, playTimeIncludeUnknown: true }))).toEqual(
      gameRangeConditions({ publishYearMax: 2019, playTimeMin: 30, playTimeIncludeUnknown: true }).map(onGame),
    );
  });
});
