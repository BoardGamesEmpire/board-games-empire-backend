import { fromAbortable, type DriverLogger, type UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';
import { from, Observable, throwError, timer } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { fetchAccessToken, TWITCH_TOKEN_URL } from './client/fetch-access-token';
import type { IgdbRequest } from './client/igdb-client.interface';
import { IgdbHttpError } from './client/igdb-http.error';
import { IgdbQuery } from './client/igdb-query';

const UNAUTHORIZED = 401;
const TOO_MANY_REQUESTS = 429;

export interface IgdbCallerOptions {
  /** How the caller reaches IGDB and Twitch; it has no other way (#1082). */
  fetch: UpstreamFetch;
  clientId: string;
  clientSecret: string;

  /** Where the access token comes from. Defaults to Twitch's endpoint. */
  tokenUrl?: string;

  /** IGDB's API. Defaults to `https://api.igdb.com/v4`. */
  baseUrl?: string;
  logger: DriverLogger;

  /** The wait before retrying a 429. Defaults to 1 second. */
  rateLimitRetryMs?: number;
}

/**
 * Runs requests against IGDB with an access token it keeps (#1082).
 *
 * Each attempt gets a fresh {@link IgdbQuery}, bound to the current token: a
 * query keeps its clauses, so sharing one between concurrent requests would
 * let their queries clobber each other. A 401 refreshes the token once, the
 * refresh shared by every call that sees one, then retries; a 429 waits, then
 * retries. Anything else propagates. Unsubscribing aborts the attempt.
 */
export class IgdbCaller {
  /**
   * Shared promise used as a mutex for token refresh. Concurrent 401
   * responses all await the same refresh rather than each triggering their
   * own token fetch.
   */
  private refreshing: Promise<void> | null = null;

  private accessToken = '';

  constructor(private readonly options: IgdbCallerOptions) {}

  /**
   * Fetch the first access token, so the first request does not pay the
   * refresh round trip. IGDB advises fetching lazily rather than refreshing
   * before expiry, so no renewal is scheduled — a 401 drives the next one.
   */
  async start(): Promise<void> {
    await this.refreshAccessToken();
  }

  call<T>(request: IgdbRequest<T>): Observable<T> {
    const attempt = () => fromAbortable((signal) => request(this.query(), signal));

    return attempt().pipe(
      catchError((err: unknown) => {
        if (err instanceof IgdbHttpError && err.status === UNAUTHORIZED) {
          this.options.logger.warn('Unauthorized error received, refreshing access token...');
          return from(this.refreshAccessToken()).pipe(switchMap(() => attempt()));
        }

        if (err instanceof IgdbHttpError && err.status === TOO_MANY_REQUESTS) {
          this.options.logger.warn('Rate limit exceeded, retrying request...');
          return timer(this.options.rateLimitRetryMs ?? 1000).pipe(switchMap(() => attempt()));
        }

        return throwError(() => err);
      }),
    );
  }

  /** A fresh query bound to the current access token. Never cache or share it. */
  private query(): IgdbQuery {
    return new IgdbQuery({
      fetch: this.options.fetch,
      clientId: this.options.clientId,
      accessToken: this.accessToken,
      baseUrl: this.options.baseUrl,
    });
  }

  private refreshAccessToken(): Promise<void> {
    this.refreshing ??= this.performRefresh().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  /**
   * Refresh the IGDB access token. Their recommendation is to NOT proactively
   * refresh the token before it expires, but instead to wait for a 401
   * response and then refresh and retry the request.
   * @see https://dev.twitch.tv/docs/authentication/refresh-tokens
   */
  private async performRefresh(): Promise<void> {
    const token = await fetchAccessToken(
      this.options.fetch,
      { client_id: this.options.clientId, client_secret: this.options.clientSecret },
      this.options.tokenUrl ?? TWITCH_TOKEN_URL,
    );

    this.accessToken = token.access_token;
    this.options.logger.info('IGDB access token refreshed');
  }
}
