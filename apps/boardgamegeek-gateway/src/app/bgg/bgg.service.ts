import { Inject, Injectable, Logger } from '@nestjs/common';
import { Http } from '@status/codes';
import { isAxiosError } from 'axios';
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
   * Default backoff applied to a 429 response when BGG does not include a
   * `Retry-After` header.
   */

  private readonly defaultRateLimitRetryMs = 2000;

  constructor(@Inject(BGG_CLIENT) private readonly client: BggClientLike) {}

  /**
   * Execute a request against the BGG API. On a 429 (rate-limited)
   * response, wait and retry once — honoring the `Retry-After` header
   * when present. All other errors propagate.
   */
  call<T>(request: BggRequest<T>): Observable<T> {
    return request(this.client).pipe(
      catchError((err: unknown) => {
        if (!isAxiosError(err) || err.response?.status !== Http.TooManyRequests) {
          return throwError(() => err);
        }

        const retryAfterMs = this.parseRetryAfterHeader(err.response.headers) ?? this.defaultRateLimitRetryMs;
        this.logger.warn(`BGG rate limit hit; retrying in ${retryAfterMs}ms`);

        return timer(retryAfterMs).pipe(switchMap(() => request(this.client)));
      }),
    );
  }

  /**
   * `Retry-After` may be either a delta in seconds or an HTTP date.
   * BGG only emits the seconds form in practice; the date form is parsed
   * defensively for forward-compatibility.
   */
  private parseRetryAfterHeader(headers: Record<string, unknown> | undefined): number | undefined {
    const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      return undefined;
    }

    const seconds = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }

    if (typeof raw === 'string') {
      const date = Date.parse(raw);
      if (Number.isFinite(date)) {
        return Math.max(0, date - Date.now());
      }
    }

    return undefined;
  }
}
