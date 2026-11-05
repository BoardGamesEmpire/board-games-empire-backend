/**
 * IGDB answered with a status other than success, such as a 401 for an
 * expired token, a 429, or a proxy's 502 page. The message names the status
 * and the endpoint.
 */
export class IgdbHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`IGDB answered ${status} for ${endpoint}`);
    this.name = 'IgdbHttpError';
  }
}
