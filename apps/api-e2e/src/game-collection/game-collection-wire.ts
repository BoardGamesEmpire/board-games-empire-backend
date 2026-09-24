import type { GameCollection } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the game-collection envelopes (#484), on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

export type GameCollectionWire = Wire<GameCollection>;

export interface ListCollectionsEnvelope {
  readonly collections: readonly GameCollectionWire[];
  readonly total: number;
}

export interface ReadCollectionEnvelope {
  readonly collection: GameCollectionWire;
}

const fail = envelopeFailure('apps/api-e2e/src/game-collection/game-collection-wire.ts');

/** Only `id` is checked: it is the one field the assertions read. */
function asCollection(value: unknown): GameCollectionWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value['id'];

  return typeof id === 'string' && id.length > 0 ? (value as unknown as GameCollectionWire) : undefined;
}

/**
 * `GET /api/game-collections` and `GET /api/game-collections/user/:userId`:
 * `{ collections: [...], pagination }`. The total is checked against the page
 * because both count the same actor-scoped set (#230): a total below the rows
 * on screen means the two disagree about scope.
 */
export function listCollectionsEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): ListCollectionsEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const collections = response.body['collections'];
  if (!Array.isArray(collections)) {
    return fail("it carried no 'collections' array", request, response);
  }

  const rows: GameCollectionWire[] = [];
  for (const entry of collections) {
    const row = asCollection(entry);
    if (row === undefined) {
      return fail('one of its collections is not an object with a string id', request, response);
    }

    rows.push(row);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { collections: rows, total };
}

/** `GET /api/game-collections/:id`: `{ collection }`. */
export function readCollectionEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): ReadCollectionEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const collection = asCollection(response.body['collection']);
  if (collection === undefined) {
    return fail("it carried no 'collection' object with a string id", request, response);
  }

  return { collection };
}
