import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription } from '../support/wire';

/**
 * Fail-loud parser for `GET /api/users/search`, on the pattern
 * `household/household-wire.ts` sets.
 */

export interface SearchedUserWire {
  readonly id: string;
  readonly username: string;
}

export interface UserSearchPageWire {
  readonly users: readonly SearchedUserWire[];
  readonly total: number;
}

const fail = envelopeFailure('apps/api-e2e/src/user/user-wire.ts');

/** `{ users: [...], pagination: { total, ... } }`. */
export function userSearchPage(response: HttpResponseLike, request: RequestDescription): UserSearchPageWire {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const { users, pagination } = response.body;
  if (!Array.isArray(users)) {
    return fail("it carried no 'users' array", request, response);
  }

  if (!isRecord(pagination) || typeof pagination['total'] !== 'number') {
    return fail("it carried no 'pagination' object with a numeric 'total'", request, response);
  }

  const rows: SearchedUserWire[] = [];
  for (const entry of users) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['username'] !== 'string') {
      return fail("one of its users is not an object with a string 'id' and 'username'", request, response);
    }

    rows.push(entry as unknown as SearchedUserWire);
  }

  return { users: rows, total: pagination['total'] };
}
