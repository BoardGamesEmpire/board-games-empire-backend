import { ContentType, GameMedium, PlatformType } from '@bge/database';
import { gameRangeConditions } from '@bge/game-search';
import { plainToInstance } from 'class-transformer';
import { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';
import { offeredGamesFilter } from './offered-games.filter';

const query = (init: Partial<ListOfferedGamesQueryDto>) => plainToInstance(ListOfferedGamesQueryDto, init);

/** The condition `platformGame` names, on an offered entry's platform game. */
const onPlatformGame = (platformGame: object) => ({ collection: { is: { platformGame: { is: platformGame } } } });

/** The condition `game` names, on an offered entry's game. */
const onGame = (game: object) => onPlatformGame({ game: { is: game } });

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

  it("filters the entry's medium both ways", () => {
    expect(offeredGamesFilter(query({ mediums: [GameMedium.Physical], excludeMediums: [GameMedium.Digital] }))).toEqual(
      [
        { collection: { is: { medium: { in: ['Physical'] } } } },
        { NOT: { collection: { is: { medium: { in: ['Digital'] } } } } },
      ],
    );
  });

  // The offered copy is one platform game, so its content type is the
  // platform game's own when it has one, else the game's (#1391).
  it("includes by the platform game's own content type, else its game's (#1391)", () => {
    expect(offeredGamesFilter(query({ contentTypes: [ContentType.DLC, ContentType.Unknown] }))).toEqual([
      onPlatformGame({
        OR: [
          { contentType: { in: ['DLC', 'Unknown'] } },
          { contentType: null, game: { is: { contentType: { in: ['DLC', 'Unknown'] } } } },
        ],
      }),
    ]);
  });

  // The platform game's own content type is nullable. A NOT over a comparison
  // with NULL is unknown, not true, so the exclude is its own positive
  // condition: a NOT of the include could drop every entry with no content
  // type of its own (#1391).
  it("excludes by the platform game's own content type, else its game's, with no NOT (#1391)", () => {
    const filter = offeredGamesFilter(query({ excludeContentTypes: [ContentType.DLC] }));

    expect(filter).toEqual([
      onPlatformGame({
        OR: [
          { contentType: { notIn: ['DLC'] } },
          { contentType: null, game: { is: { contentType: { notIn: ['DLC'] } } } },
        ],
      }),
    ]);
    expect(JSON.stringify(filter)).not.toContain('NOT');
  });

  it('takes a content type include and exclude at once (#1391)', () => {
    expect(
      offeredGamesFilter(query({ contentTypes: [ContentType.BaseGame], excludeContentTypes: [ContentType.Expansion] })),
    ).toEqual([
      onPlatformGame({
        OR: [
          { contentType: { in: ['BaseGame'] } },
          { contentType: null, game: { is: { contentType: { in: ['BaseGame'] } } } },
        ],
      }),
      onPlatformGame({
        OR: [
          { contentType: { notIn: ['Expansion'] } },
          { contentType: null, game: { is: { contentType: { notIn: ['Expansion'] } } } },
        ],
      }),
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
