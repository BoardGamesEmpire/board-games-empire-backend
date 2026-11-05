/**
 * BGG answered with a status other than success or "still preparing", such
 * as a 429 or a proxy's 502 page. The message names the status and the
 * endpoint; the URL's query, which can hold a search term, stays out of it
 * (#1082).
 */
export class BggHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,

    /** How long BGG asked to be left alone, from a `Retry-After` given in seconds. */
    readonly retryAfterMs?: number,
  ) {
    super(`BGG answered ${status} for ${url.split('?')[0]}`);
    this.name = 'BggHttpError';
  }
}
