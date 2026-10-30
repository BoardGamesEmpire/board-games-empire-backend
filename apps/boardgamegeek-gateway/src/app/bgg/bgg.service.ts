import { Inject, Injectable, Logger } from '@nestjs/common';
import { Http } from '@status/codes';
import { BggApiError, BggClientError } from 'bgg-ts-client';
import { Observable, throwError, timer } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { BGG_CLIENT } from './constants';
import type { BggClientLike } from './interfaces';

/**
 * A unit of work that takes the BGG client and produces an Observable of
 * its result. Request factories must be lazy — each subscription
 * (initial or retry) re-invokes the underlying client method, typically
 * via an internal `defer(() => client.method(...))`.
 */
export type BggRequest<T> = (client: BggClientLike) => Observable<T>;

/**
 * Wrapper around the BoardGameGeek client. Each `call()` is an
 * independent retry boundary — callers that compose multiple `call()`s
 * (e.g. base-thing lookup followed by batched expansion fetches) get
 * per-sub-request retry treatment, so a 429 on one sub-request retries
 * only that sub-request rather than re-running the whole composition.
 *
 * BGG's 202 (still preparing) responses are non-error status codes and
 * are handled inside the underlying client library — they never reach
 * this layer as exceptions.
 */
@Injectable()
export class BggService {
  private readonly logger = new Logger(BggService.name);

  /**
   * Backoff applied to a 429 response. `bgg-ts-client`'s error carries the
   * status alone, so BGG's `Retry-After` header never reaches this layer.
   */
  private readonly rateLimitRetryMs = 2000;

  constructor(@Inject(BGG_CLIENT) private readonly client: BggClientLike) {}

  /**
   * Execute a request against the BGG API. On a 429 (rate-limited)
   * response, wait and retry once. All other errors propagate.
   */
  call<T>(request: BggRequest<T>): Observable<T> {
    return request(this.client).pipe(
      catchError((err: unknown) => {
        if (!isRateLimit(err)) {
          return throwError(() => err);
        }

        this.logger.warn(`BGG rate limit hit; retrying in ${this.rateLimitRetryMs}ms`);

        return timer(this.rateLimitRetryMs).pipe(switchMap(() => request(this.client)));
      }),
    );
  }
}

/** A 429 as `bgg-ts-client` throws it: its status on the `BggApiError` a `BggClientError` wraps (#880). */
function isRateLimit(err: unknown): boolean {
  return (
    err instanceof BggClientError && err.cause instanceof BggApiError && err.cause.statusCode === Http.TooManyRequests
  );
}
