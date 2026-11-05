import type { Game, GameCollection, Platform, PlatformGame } from '@bge/database';
import type { ExpansionLinkWire } from '../game/game-wire';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the game-collection envelopes (#484), on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

export type GameCollectionWire = Wire<GameCollection>;

/** The game a collection row embeds (#1070). */
export type CollectionRowGameWire = Wire<
  Pick<
    Game,
    | 'id'
    | 'title'
    | 'subtitle'
    | 'image'
    | 'thumbnail'
    | 'contentType'
    | 'publishYear'
    | 'minPlayers'
    | 'maxPlayers'
    | 'minPlayTime'
    | 'maxPlayTime'
  >
> & { readonly baseGames: readonly ExpansionLinkWire[] };

/** The platform game a collection row embeds, with its platform and game (#1070). */
export type CollectionRowPlatformGameWire = Wire<
  Pick<PlatformGame, 'id' | 'image' | 'thumbnail' | 'minPlayers' | 'maxPlayers' | 'minPlayTime' | 'maxPlayTime'>
> & {
  readonly platform: Pick<Platform, 'id' | 'name' | 'slug' | 'platformType'>;
  readonly game: CollectionRowGameWire;
};

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
 * `GET /api/game-collections` and `GET /api/users/:userId/game-collections`:
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

/**
 * A collection row's embedded platform game (#1070). An absent platform game or
 * game would make every fact on it read as missing, so either fails here
 * rather than as an assertion against `undefined`.
 */
export function collectionRowPlatformGame(
  row: GameCollectionWire,
  request: RequestDescription,
): CollectionRowPlatformGameWire {
  const platformGame = (row as unknown as Record<string, unknown>)['platformGame'];
  if (!isRecord(platformGame) || !isRecord(platformGame['game'])) {
    throw new Error(
      `${request}: collection row ${row.id} carried no 'platformGame.game' object. The row's embedded ` +
        'platform game has changed — update apps/api-e2e/src/game-collection/game-collection-wire.ts to match.',
    );
  }

  return platformGame as unknown as CollectionRowPlatformGameWire;
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
