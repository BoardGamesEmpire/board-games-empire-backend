import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Http } from '@status/codes';
import { isAxiosError } from 'axios';
import { from, Observable, throwError } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import type { IGDBConfig } from './configuration/igdb.config';
import { IGDB_CLIENT_FACTORY } from './constants';
import { IgdbAuthService } from './igdb-auth.service';
import type { IGDBClient } from './interfaces';

export type IgdbRequest<T> = (igdb: IGDBClient) => Promise<T>;

/**
 * Produces a fresh IGDB client bound to the supplied access token.
 *
 * A new client MUST be created per request. The underlying apicalypse builder
 * stores query state (fields, search, where, limit…) on the instance and
 * mutates it in place, resetting only after each `request()`. Sharing one
 * client across concurrent requests lets their query builders clobber each
 * other, persisting results against the wrong game.
 */
export type IgdbClientFactory = (accessToken: string) => IGDBClient;

@Injectable()
export class IGDBService implements OnModuleInit {
  private readonly logger = new Logger(IGDBService.name);

  /**
   * Shared promise used as a mutex for token refresh. Concurrent 401
   * responses all await the same refresh rather than each triggering their
   * own token fetch.
   */
  private refreshPromise: Promise<void> | null = null;

  private accessToken = '';

  constructor(
    @Inject(IGDB_CLIENT_FACTORY) private readonly createClient: IgdbClientFactory,
    private readonly authService: IgdbAuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Fetch the initial access token at startup so the first request does not
   * pay the refresh round-trip. IGDB advises fetching lazily rather than
   * proactively refreshing before expiry, so we do not schedule renewals —
   * a 401 drives the next refresh.
   */
  async onModuleInit(): Promise<void> {
    await this.refreshAccessToken();
  }

  /**
   * Execute a request against the IGDB API. On a 401 response the access
   * token is refreshed once and the request is retried. 429 responses are
   * retried after a delay. All other errors propagate immediately.
   *
   * Each attempt receives its own client instance — see {@link IgdbClientFactory}.
   */
  call<T>(request: IgdbRequest<T>): Observable<T> {
    return from(request(this.client())).pipe(
      catchError((err) => {
        if (isAxiosError(err)) {
          if (err.response?.status === Http.Unauthorized) {
            this.logger.warn('Unauthorized error received, refreshing access token...');
            return from(this.refreshAccessToken()).pipe(switchMap(() => request(this.client())));
          }

          if (err.response?.status === Http.TooManyRequests) {
            this.logger.warn('Rate limit exceeded, retrying request...');
            // TODO: Are there headers for rate limit reset time? - investigate
            return from(new Promise((resolve) => setTimeout(resolve, 1000))).pipe(
              switchMap(() => request(this.client())),
            );
          }
        }

        return throwError(() => err);
      }),
    );
  }

  /**
   * Build a fresh client bound to the current access token for a single
   * request. Never cache or share the returned client — see {@link IgdbClientFactory}.
   */
  private client(): IGDBClient {
    return this.createClient(this.accessToken);
  }

  private async refreshAccessToken() {
    this.refreshPromise ??= this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Refresh the IGDB access token. Their recommendation is to NOT proactively
   * refresh the token before it expires, but instead to wait for a 401 response and then refresh and retry the request.
   * @see https://dev.twitch.tv/docs/authentication/refresh-tokens
   */
  private async performRefresh() {
    const credentials = this.configService.getOrThrow<IGDBConfig>('igdb');
    const accessTokenResponse = await this.authService.fetchAccessToken({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });

    this.accessToken = accessTokenResponse.access_token;
    this.logger.log('IGDB access token refreshed');
  }
}
