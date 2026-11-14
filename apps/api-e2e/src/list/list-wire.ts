import type { List, ListEntry } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the list and list entry envelopes (#1241), on the
 * pattern `game-collection/game-collection-wire.ts` sets: `supertest` types
 * `response.body` as `any`, so a renamed envelope key would otherwise surface
 * as an assertion against `undefined` that names neither the key nor the change.
 */

/** A list as the routes return it: its columns and the number of entries it holds. */
export type ListWire = Wire<List> & { readonly _count: { readonly entries: number } };

/** A list entry as the routes return it, with the game or platform game it names embedded. */
export type ListEntryWire = Wire<ListEntry> & {
  readonly game: { readonly id: string; readonly title: string } | null;
  readonly platformGame: {
    readonly id: string;
    readonly game: { readonly id: string; readonly title: string };
  } | null;
};

export interface ListsEnvelope {
  readonly lists: readonly ListWire[];
  readonly total: number;
}

export interface ListEntriesEnvelope {
  readonly entries: readonly ListEntryWire[];
  readonly total: number;
}

const fail = envelopeFailure('apps/api-e2e/src/list/list-wire.ts');

/** Only `id` is checked: it is the one field every assertion reads. */
function hasId(value: unknown): value is Record<string, unknown> & { readonly id: string } {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0;
}

function pageOf<TRow>(
  key: string,
  response: HttpResponseLike,
  request: RequestDescription,
): { readonly rows: readonly TRow[]; readonly total: number } {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const rows = response.body[key];
  if (!Array.isArray(rows)) {
    return fail(`it carried no '${key}' array`, request, response);
  }

  if (!rows.every(hasId)) {
    return fail(`one of its ${key} is not an object with a string id`, request, response);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { rows: rows as TRow[], total };
}

function oneOf<TRow>(key: string, response: HttpResponseLike, request: RequestDescription): TRow {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const row = response.body[key];
  if (!hasId(row)) {
    return fail(`it carried no '${key}' object with a string id`, request, response);
  }

  return row as unknown as TRow;
}

/** `GET /api/lists` and `GET /api/users/:userId/lists`: `{ lists: [...], pagination }`. */
export function listsEnvelope(response: HttpResponseLike, request: RequestDescription): ListsEnvelope {
  const { rows, total } = pageOf<ListWire>('lists', response, request);

  return { lists: rows, total };
}

/** The list routes that answer one list: `{ list }`, with `message` on a write. */
export function listEnvelope(response: HttpResponseLike, request: RequestDescription): ListWire {
  return oneOf<ListWire>('list', response, request);
}

/** `PUT /api/lists/order`: `{ lists: [...] }` with no pagination. */
export function reorderedListsEnvelope(response: HttpResponseLike, request: RequestDescription): readonly ListWire[] {
  if (!isRecord(response.body) || !Array.isArray(response.body['lists']) || !response.body['lists'].every(hasId)) {
    return fail("it carried no 'lists' array of objects with string ids", request, response);
  }

  return response.body['lists'] as ListWire[];
}

/** `GET /api/lists/:listId/entries`: `{ entries: [...], pagination }`. */
export function listEntriesEnvelope(response: HttpResponseLike, request: RequestDescription): ListEntriesEnvelope {
  const { rows, total } = pageOf<ListEntryWire>('entries', response, request);

  return { entries: rows, total };
}

/** The entry routes that answer one entry: `{ entry, message }`. */
export function listEntryEnvelope(response: HttpResponseLike, request: RequestDescription): ListEntryWire {
  return oneOf<ListEntryWire>('entry', response, request);
}

/** `PUT /api/lists/:listId/entries/order`: `{ entries: [...] }` with no pagination. */
export function reorderedEntriesEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): readonly ListEntryWire[] {
  if (!isRecord(response.body) || !Array.isArray(response.body['entries']) || !response.body['entries'].every(hasId)) {
    return fail("it carried no 'entries' array of objects with string ids", request, response);
  }

  return response.body['entries'] as ListEntryWire[];
}
