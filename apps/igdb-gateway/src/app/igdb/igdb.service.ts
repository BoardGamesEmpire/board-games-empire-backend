import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import igdb from 'igdb-api-node';
import { from, Observable, throwError } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import type { IGDBConfig } from './configuration/igdb.config';
import { IGDB_CLIENT } from './constants';
import type { IGDBClient } from './interfaces';
import { fetchAccessToken } from './lib/fetch-access-token';

export type IgdbRequest<T> = (igdb: IGDBClient) => Promise<T>;

@Injectable()
export class IGDBService {
  private readonly logger = new Logger(IGDBService.name);

  /**
   * Shared promise used as a mutex for token refresh. Concurrent 401
   * responses all await the same refresh rather than each triggering their
   * own token fetch.
   */
  private refreshPromise: Promise<void> | null = null;

  constructor(@Inject(IGDB_CLIENT) private igdbClient: IGDBClient, private readonly configService: ConfigService) {}

  /**
   * Execute a request against the IGDB API. On a 401 response the access
   * token is refreshed once and the request is retried. 429 responses are
   * retried after a delay. All other errors propagate immediately.
   */
  call<T>(request: IgdbRequest<T>): Observable<T> {
    return from(request(this.igdbClient)).pipe(
      catchError((err) => {
        if (isAxiosError(err)) {
          if (err.response?.status === HttpStatus.UNAUTHORIZED) {
            this.logger.warn('Unauthorized error received, refreshing access token...');
            return from(this.refreshAccessToken()).pipe(switchMap(() => request(this.igdbClient)));
          }

          if (err.response?.status === HttpStatus.TOO_MANY_REQUESTS) {
            this.logger.warn('Rate limit exceeded, retrying request...');
            // TODO: Are there headers for rate limit reset time? - investigate
            return from(new Promise((resolve) => setTimeout(resolve, 1000))).pipe(
              switchMap(() => request(this.igdbClient)),
            );
          }
        }

        return throwError(() => err);
      }),
    );
  }

  private async refreshAccessToken() {
    this.refreshPromise ??= this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Refresh the IGDB access token and update the client instance. Their recommendation is to NOT proactively
   * refresh the token before it expires, but instead to wait for a 401 response and then refresh and retry the request.
   * @see https://dev.twitch.tv/docs/authentication/refresh-tokens
   */
  private async performRefresh() {
    const credentials = this.configService.getOrThrow<IGDBConfig>('igdb');
    const accessTokenResponse = await fetchAccessToken({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });

    // I don't think there is a way to update the access token on the existing client, so we need to create a new one
    this.igdbClient = igdb(credentials.clientId, accessTokenResponse.access_token);
    this.logger.log('IGDB access token refreshed');
  }
}
