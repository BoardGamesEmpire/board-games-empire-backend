import type { Game } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the game envelopes (#472), on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

export type GameWire = Wire<Game>;

export interface ListGamesEnvelope {
  readonly games: readonly GameWire[];
  readonly total: number;
}

export interface GameEnvelope {
  readonly game: GameWire;
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
