import type { Game, Platform, PlatformGame } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the game envelopes (#472), on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

export type GameWire = Wire<Game>;

/** One row of `GET /api/games/:id`'s `game.platformGames` (#791). */
export type PlatformGameWire = Wire<Omit<PlatformGame, 'platformId' | 'enrichmentSource' | 'frozenAt'>> & {
  readonly platform: Pick<Platform, 'id' | 'name' | 'abbreviation' | 'platformType'>;
};

/** One expansion link as the game routes send it (#1069). */
export interface ExpansionLinkWire {
  readonly gameId: string;
  readonly isStandalone: boolean;
}

/** The game at the far end of a link on `GET /api/games/:id` (#1069). */
export type LinkedGameWire = Pick<GameWire, 'id' | 'title' | 'thumbnail' | 'contentType'>;

/** One of `GET /api/games/:id`'s `game.expansions` (#1069). */
export interface LinkedExpansionWire extends ExpansionLinkWire {
  readonly game: LinkedGameWire;
  readonly platformIds: readonly string[];
}

/** One of `GET /api/games/:id`'s `game.baseGames` (#1069). */
export interface LinkedBaseGameWire extends ExpansionLinkWire {
  readonly game: LinkedGameWire;
}

export interface ListGamesEnvelope {
  readonly games: readonly GameWire[];
  readonly total: number;
}

export interface GameEnvelope {
  readonly game: GameWire;
}

export interface RandomGamesEnvelope {
  readonly games: readonly GameWire[];
}

export interface GamePoolSampleEnvelope {
  readonly games: readonly GameWire[];
  readonly gameCount: number;
}

const fail = envelopeFailure('apps/api-e2e/src/game/game-wire.ts');

/** Only `id` is checked: it is the field every assertion keys on. */
function asGame(value: unknown): GameWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value['id'];

  return typeof id === 'string' && id.length > 0 ? (value as unknown as GameWire) : undefined;
}

/**
 * `GET /api/games`: `{ games: [...], pagination }`. The total is checked against
 * the page because both count the same actor-scoped set (#372): a total below
 * the rows on screen means the two disagree about scope.
 */
export function listGamesEnvelope(response: HttpResponseLike, request: RequestDescription): ListGamesEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const games = response.body['games'];
  if (!Array.isArray(games)) {
    return fail("it carried no 'games' array", request, response);
  }

  const rows: GameWire[] = [];
  for (const entry of games) {
    const row = asGame(entry);
    if (row === undefined) {
      return fail('one of its games is not an object with a string id', request, response);
    }

    rows.push(row);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { games: rows, total };
}

/**
 * The `games` array of a random sample (#960, #961): every entry a game with a
 * string id. Shared by the two sample envelopes, which differ only in what
 * travels beside it.
 */
export function gameSummaries(
  body: Record<string, unknown>,
  request: RequestDescription,
  response: HttpResponseLike,
): GameWire[] {
  const games = body['games'];
  if (!Array.isArray(games)) {
    return fail("it carried no 'games' array", request, response);
  }

  return games.map((entry) => {
    const game = asGame(entry);
    if (game === undefined) {
      return fail('one of its games is not an object with a string id', request, response);
    }

    return game;
  });
}

/** `GET /api/games/random`: `{ games }` (#961). */
export function randomGamesEnvelope(response: HttpResponseLike, request: RequestDescription): RandomGamesEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  return { games: gameSummaries(response.body, request, response) };
}

/**
 * `GET /api/households/game-pool/random`: `{ games, gameCount }` (#960). The
 * count is checked against the sample because both cover the same game pool:
 * a count below the games on screen means the two disagree about it.
 */
export function gamePoolSampleEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): GamePoolSampleEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const games = gameSummaries(response.body, request, response);
  const gameCount = response.body['gameCount'];
  if (typeof gameCount !== 'number' || !Number.isInteger(gameCount) || gameCount < games.length) {
    return fail("it carried no integer 'gameCount' at least as large as its sample", request, response);
  }

  return { games, gameCount };
}

/** `GET /api/games/:id`, `POST /api/games`, `PATCH /api/games/:id`: `{ game }`. */
export function gameEnvelope(response: HttpResponseLike, request: RequestDescription): GameEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const game = asGame(response.body['game']);
  if (game === undefined) {
    return fail("it carried no 'game' object with a string id", request, response);
  }

  return { game };
}

/**
 * `GET /api/games/:id`: the game's platform games (#791). An empty list and an
 * absent one mean different things here, so an absent one fails rather than
 * reading as empty.
 */
export function gamePlatformGames(
  response: HttpResponseLike,
  request: RequestDescription,
): readonly PlatformGameWire[] {
  const { game } = gameEnvelope(response, request);
  const platformGames = (game as unknown as Record<string, unknown>)['platformGames'];
  if (!Array.isArray(platformGames)) {
    return fail("its 'game' carried no 'platformGames' array", request, response);
  }

  return platformGames as PlatformGameWire[];
}

/**
 * `GET /api/games`: the `baseGames` of the row for `gameId` (#1069). An absent
 * list would read as an expansion with no visible base game, so it fails, as
 * does a page without the row: every caller here expects the game listed.
 */
export function listRowBaseGames(
  response: HttpResponseLike,
  gameId: string,
  request: RequestDescription,
): readonly ExpansionLinkWire[] {
  const row = listGamesEnvelope(response, request).games.find((game) => game.id === gameId);
  if (row === undefined) {
    return fail(`its page carried no row for game ${gameId}`, request, response);
  }

  const baseGames = (row as unknown as Record<string, unknown>)['baseGames'];
  if (!Array.isArray(baseGames)) {
    return fail(`its row for game ${gameId} carried no 'baseGames' array`, request, response);
  }

  return baseGames as ExpansionLinkWire[];
}

/**
 * `GET /api/games/:id`: the game's `expansions` and `baseGames` (#1069). As
 * with its platform games, an absent list fails rather than reading as empty.
 */
export function gameExpansionLinks(
  response: HttpResponseLike,
  request: RequestDescription,
): { readonly expansions: readonly LinkedExpansionWire[]; readonly baseGames: readonly LinkedBaseGameWire[] } {
  const { game } = gameEnvelope(response, request);
  const { expansions, baseGames } = game as unknown as Record<string, unknown>;
  if (!Array.isArray(expansions)) {
    return fail("its 'game' carried no 'expansions' array", request, response);
  }

  if (!Array.isArray(baseGames)) {
    return fail("its 'game' carried no 'baseGames' array", request, response);
  }

  return { expansions: expansions as LinkedExpansionWire[], baseGames: baseGames as LinkedBaseGameWire[] };
}

/**
 * `GET /api/games/search`: the ids of the local-database hits. The service
 * leaves `resultsBySource.local` out when there are none, so an absent key is
 * an empty result, but an absent `resultsBySource` is a changed envelope.
 */
export function localSearchGameIds(response: HttpResponseLike, request: RequestDescription): readonly string[] {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const bySource = response.body['resultsBySource'];
  if (!isRecord(bySource)) {
    return fail("it carried no 'resultsBySource' object", request, response);
  }

  const local = bySource['local'];
  if (local === undefined) {
    return [];
  }

  if (!Array.isArray(local)) {
    return fail("its 'resultsBySource.local' is not an array", request, response);
  }

  return local.map((hit) => {
    const gameId = isRecord(hit) ? hit['gameId'] : undefined;
    if (typeof gameId !== 'string' || gameId.length === 0) {
      return fail("one of its local hits carried no string 'gameId'", request, response);
    }

    return gameId;
  });
}
