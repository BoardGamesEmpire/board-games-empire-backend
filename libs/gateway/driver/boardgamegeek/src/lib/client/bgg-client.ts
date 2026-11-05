import { discardBody, type UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';
import { setTimeout as wait } from 'node:timers/promises';
import type { BggClientLike, BggSearchQueryParams, BggThingQueryParams } from './bgg-client.interface';
import { BggHttpError } from './bgg-http.error';
import { parseSearch, parseThings } from './bgg-xml';

export const BGG_BASE_URL = 'https://boardgamegeek.com/xmlapi2';

export interface BggClientOptions {
  /** How the client reaches BGG; it has no other way (#1082). */
  fetch: UpstreamFetch;
  apiKey: string;

  /** Defaults to {@link BGG_BASE_URL}. */
  baseUrl?: string;

  /** How long to wait before asking again after a 202. Defaults to 6 seconds. */
  acceptedRetryMs?: number;

  /** How many times to ask again after a 202 before giving up. Defaults to 5. */
  acceptedRetries?: number;
}

type QueryValue = string | number | readonly (string | number)[] | undefined;

/**
 * A query string with each parameter in the order given, and each value
 * encoded, list items joined by commas. A parameter with no value is left
 * out.
 */
const queryString = (params: Readonly<Record<string, QueryValue>>): string =>
  Object.entries(params)
    .flatMap(([name, value]) => {
      if (value === undefined) {
        return [];
      }

      const values: readonly (string | number)[] = Array.isArray(value) ? value : [value as string | number];
      return [`${name}=${values.map((each) => encodeURIComponent(each)).join(',')}`];
    })
    .join('&');

/** A `Retry-After` given in seconds, as milliseconds. A date, or nothing, gives undefined. */
const retryAfterMs = (header: string | null): number | undefined => {
  const seconds = header === null || header.trim() === '' ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

/**
 * BGG's XML API 2, through the fetch the client is handed (#1082). It asks
 * with the API key, waits out a 202 by asking again, and parses the answer
 * itself, keeping BGG's text as sent (#863). Any other status that isn't a
 * success fails with a {@link BggHttpError}. An aborted call stops at once,
 * between tries too.
 */
export function createBggClient(options: BggClientOptions): BggClientLike {
  const baseUrl = options.baseUrl ?? BGG_BASE_URL;
  const acceptedRetryMs = options.acceptedRetryMs ?? 6000;
  const acceptedRetries = options.acceptedRetries ?? 5;
  const headers = { Authorization: `Bearer ${options.apiKey}` };

  const get = async (endpoint: string, params: Readonly<Record<string, QueryValue>>, signal?: AbortSignal) => {
    const url = `${baseUrl}/${endpoint}?${queryString(params)}`;
    const ask = () => options.fetch(url, { method: 'GET', headers, signal });

    let response = await ask();

    for (let retries = 0; response.status === 202 && retries < acceptedRetries; retries++) {
      await discardBody(response);
      await wait(acceptedRetryMs, undefined, { signal });
      response = await ask();
    }

    if (response.status === 202) {
      await discardBody(response);
      throw new Error(`BGG API still processing after ${acceptedRetries} retries`);
    }

    if (!response.ok) {
      await discardBody(response);
      throw new BggHttpError(response.status, url, retryAfterMs(response.headers.get('retry-after')));
    }

    return response.text();
  };

  return {
    thing: {
      query: async (params: BggThingQueryParams, signal?: AbortSignal) =>
        parseThings(await get('thing', { ...params }, signal)),
    },
    search: {
      query: async (params: BggSearchQueryParams, signal?: AbortSignal) => [
        parseSearch(await get('search', { ...params }, signal)),
      ],
    },
  };
}
