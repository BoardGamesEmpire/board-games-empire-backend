import type { Friendship } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the friendship envelopes, on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

export type FriendshipWire = Wire<Friendship>;

export interface ListFriendshipsEnvelope {
  readonly friendships: readonly FriendshipWire[];
  readonly total: number;
}

const fail = envelopeFailure('apps/api-e2e/src/friendship/friendship-wire.ts');

/** Only `id` is checked: it is the one field the assertions read. */
function asFriendship(value: unknown): FriendshipWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value['id'];

  return typeof id === 'string' && id.length > 0 ? (value as unknown as FriendshipWire) : undefined;
}

/**
 * `GET /api/friendships`: `{ friendships: [...], pagination }`. The total is
 * checked against the page because both count the same actor-scoped set
 * (#230): a total below the rows on screen means the two disagree about scope.
 */
export function listFriendshipsEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): ListFriendshipsEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const friendships = response.body['friendships'];
  if (!Array.isArray(friendships)) {
    return fail("it carried no 'friendships' array", request, response);
  }

  const rows: FriendshipWire[] = [];
  for (const entry of friendships) {
    const row = asFriendship(entry);
    if (row === undefined) {
      return fail('one of its friendships is not an object with a string id', request, response);
    }

    rows.push(row);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { friendships: rows, total };
}
