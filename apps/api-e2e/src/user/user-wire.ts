import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription } from '../support/wire';

/**
 * Fail-loud parsers for `GET /api/users/search` and the profile routes, on
 * the pattern `household/household-wire.ts` sets.
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

/** A profile as the caller is served it. The tests check the keys beyond the identity themselves. */
export interface UserProfileWire extends Readonly<Record<string, unknown>> {
  readonly userId: string;
  readonly username: string;
}

/** `{ profile: { userId, username, ... } }`, from the profile routes (#819). */
export function userProfile(response: HttpResponseLike, request: RequestDescription): UserProfileWire {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const { profile } = response.body;
  if (!isRecord(profile) || typeof profile['userId'] !== 'string' || typeof profile['username'] !== 'string') {
    return fail("it carried no 'profile' object with a string 'userId' and 'username'", request, response);
  }

  return profile as UserProfileWire;
}
