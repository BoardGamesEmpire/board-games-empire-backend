import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription } from '../support/wire';

/**
 * Fail-loud parsers for the media-object envelopes (#514), on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

/**
 * Deliberately partial: the served shape is the media lib's
 * `MediaObjectResponse`, and only the fields an assertion reads are declared,
 * so an assertion on any other one is a compile error rather than a green
 * test against `undefined`.
 */
export interface MediaObjectWire {
  readonly id: string;
}

export interface ListMediaEnvelope {
  readonly media: readonly MediaObjectWire[];
  readonly total: number;
}

export interface ReadMediaEnvelope {
  readonly media: MediaObjectWire;
}

const fail = envelopeFailure('apps/api-e2e/src/media/media-wire.ts');

function asMediaObject(value: unknown): MediaObjectWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value['id'];

  return typeof id === 'string' && id.length > 0 ? (value as unknown as MediaObjectWire) : undefined;
}

/**
 * `GET /api/media`: `{ media: [...], pagination }`. The total is checked
 * against the page because both count the same scoped set (#230): a total
 * below the rows on screen means the two disagree about scope.
 */
export function listMediaEnvelope(response: HttpResponseLike, request: RequestDescription): ListMediaEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const media = response.body['media'];
  if (!Array.isArray(media)) {
    return fail("it carried no 'media' array", request, response);
  }

  const rows: MediaObjectWire[] = [];
  for (const entry of media) {
    const row = asMediaObject(entry);
    if (row === undefined) {
      return fail('one of its media objects is not an object with a string id', request, response);
    }

    rows.push(row);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { media: rows, total };
}

/** `GET /api/media/:id`: `{ media }`. */
export function readMediaEnvelope(response: HttpResponseLike, request: RequestDescription): ReadMediaEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const media = asMediaObject(response.body['media']);
  if (media === undefined) {
    return fail("it carried no 'media' object with a string id", request, response);
  }

  return { media };
}
