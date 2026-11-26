import type { Game, GameCollection, Platform, PlatformGame } from '@bge/database';
import { GameCondition, GameRemovalReason } from '@bge/database';
import { z } from 'zod';
import type { ExpansionLinkWire } from '../game/game-wire';
import type { HttpResponseLike, RequestDescription, Wire } from '../support/wire';
import { envelopeFailure, isRecord } from '../support/wire';

/**
 * Fail-loud parsers for the game-collection envelopes (#484), on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

/**
 * `onWishlist` is sent on `GET /users/:userId/game-collections` only, and is
 * null for an actor with no wishlist they can read (#1241). `quantity` is the
 * number of copies the owner still has, counted rather than stored (#1231).
 */
export type GameCollectionWire = Wire<GameCollection> & {
  readonly onWishlist?: boolean | null;
  readonly quantity: number;
};

/** The players and play time a game carries and its platform game may override (#1070). */
export type PlayerAndPlayTimeField = 'minPlayers' | 'maxPlayers' | 'minPlayTime' | 'maxPlayTime';

/** The game a collection row embeds (#1070). */
export type CollectionRowGameWire = Wire<
  Pick<
    Game,
    'id' | 'title' | 'subtitle' | 'image' | 'thumbnail' | 'contentType' | 'publishYear' | PlayerAndPlayTimeField
  >
> & { readonly baseGames: readonly ExpansionLinkWire[] };

/**
 * The platform game a collection row embeds, with its platform and game
 * (#1070), and its own content type, null when it overrides none (#1391).
 */
export type CollectionRowPlatformGameWire = Wire<
  Pick<PlatformGame, 'id' | 'image' | 'thumbnail' | 'contentType' | PlayerAndPlayTimeField>
> & {
  readonly game: CollectionRowGameWire;
  readonly platform: Pick<Platform, 'id' | 'name' | 'slug' | 'platformType'>;
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
 * game would make every fact on it read as missing, and an absent `baseGames`
 * would read as an expansion with no visible base game, so each fails here
 * rather than as an assertion against `undefined`.
 */
export function collectionRowPlatformGame(
  row: GameCollectionWire,
  request: RequestDescription,
): CollectionRowPlatformGameWire {
  const platformGame = (row as unknown as Record<string, unknown>)['platformGame'];
  const game = isRecord(platformGame) ? platformGame['game'] : undefined;
  if (!isRecord(game) || !Array.isArray(game['baseGames'])) {
    throw new Error(
      `${request}: collection row ${row.id} carried no 'platformGame.game.baseGames' array. The row's ` +
        'embedded platform game has changed — update apps/api-e2e/src/game-collection/game-collection-wire.ts to match.',
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

/** A price on the wire: whole minor units and an ISO 4217 code (#1231). */
const moneyWireSchema = z.object({ amount: z.number().int(), currency: z.string() }).strict();

/**
 * A copy as its owner reads it (#1231). Strict, so a field the owner's shape
 * doesn't name, such as when the user last edited it or its upstream
 * account, fails the parse rather than passing unread.
 */
export const collectionCopyWireSchema = z
  .object({
    acquiredFrom: z.string().nullable(),
    acquiredOn: z.string().nullable(),
    condition: z.enum(GameCondition).nullable(),
    createdAt: z.string(),
    currentValue: moneyWireSchema.nullable(),
    id: z.string().min(1),
    note: z.string().nullable(),
    pricePaid: moneyWireSchema.nullable(),
    release: z
      .object({ editionName: z.string().nullable(), id: z.string().min(1), releaseYear: z.number().nullable() })
      .strict()
      .nullable(),
    removedAt: z.string().nullable(),
    removedOn: z.string().nullable(),
    removeReason: z.enum(GameRemovalReason).nullable(),
  })
  .strict();

export type CollectionCopyWire = z.infer<typeof collectionCopyWireSchema>;

const copyEnvelopeSchema = z.object({ copy: collectionCopyWireSchema });

const listCopiesEnvelopeSchema = z.object({ copies: z.array(collectionCopyWireSchema) });

/** `POST`, `PATCH` and `DELETE` on `/api/game-collections/:id/copies`: `{ copy, message }` (#1231). */
export function copyEnvelope(response: HttpResponseLike, request: RequestDescription): CollectionCopyWire {
  const parsed = copyEnvelopeSchema.safeParse(response.body);
  if (!parsed.success) {
    return fail(`its 'copy' is not a copy as its owner reads it (${parsed.error.message})`, request, response);
  }

  return parsed.data.copy;
}

/** `GET /api/game-collections/:id/copies`: `{ copies: [...] }` (#1231). */
export function listCopiesEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): readonly CollectionCopyWire[] {
  const parsed = listCopiesEnvelopeSchema.safeParse(response.body);
  if (!parsed.success) {
    return fail(
      `its 'copies' is not a list of copies as their owner reads them (${parsed.error.message})`,
      request,
      response,
    );
  }

  return parsed.data.copies;
}
