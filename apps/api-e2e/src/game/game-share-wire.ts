import type { GameShare } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the game share envelopes (#810), on the pattern
 * `game-wire.ts` sets: `supertest` types `response.body` as `any`, so a
 * renamed envelope key would otherwise surface as an assertion against
 * `undefined` that names neither the key nor the change.
 */

export type GameShareWire = Wire<GameShare>;

export interface GameShareEnvelope {
  readonly share: GameShareWire;
}

export interface ListGameSharesEnvelope {
  readonly shares: readonly GameShareWire[];
  readonly total: number;
}

const fail = envelopeFailure('apps/api-e2e/src/game/game-share-wire.ts');

/** Only `id` is checked: it is the field every assertion keys on. */
function asShare(value: unknown): GameShareWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value['id'];

  return typeof id === 'string' && id.length > 0 ? (value as unknown as GameShareWire) : undefined;
}

/** `POST /api/games/:id/shares`: `{ share }`. */
export function gameShareEnvelope(response: HttpResponseLike, request: RequestDescription): GameShareEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const share = asShare(response.body['share']);
  if (share === undefined) {
    return fail("it carried no 'share' object with a string id", request, response);
  }

  return { share };
}

/**
 * `GET /api/games/:id/shares`: `{ shares: [...], pagination }`. The total is
 * checked against the page because both count the same composed set (#372).
 */
export function listGameSharesEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): ListGameSharesEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const shares = response.body['shares'];
  if (!Array.isArray(shares)) {
    return fail("it carried no 'shares' array", request, response);
  }

  const rows: GameShareWire[] = [];
  for (const entry of shares) {
    const row = asShare(entry);
    if (row === undefined) {
      return fail('one of its shares is not an object with a string id', request, response);
    }

    rows.push(row);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { shares: rows, total };
}
