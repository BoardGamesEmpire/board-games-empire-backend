import type { DriverLogger } from '@boardgamesempire/gateway-driver-contract';
import { Observable, throwError, timer } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import type { BggClientLike, BggRequest } from './client/bgg-client.interface';
import { BggHttpError } from './client/bgg-http.error';

const TOO_MANY_REQUESTS = 429;

export interface BggCallerOptions {
  /** The wait before retrying a 429 that names none. Defaults to 2 seconds. */
  rateLimitRetryMs?: number;

  /**
   * The longest wait a 429's `Retry-After` may ask for. A 429 that asks for
   * longer fails at once rather than hold the call. Defaults to 30 seconds.
   */
  maxRateLimitWaitMs?: number;
}

/**
 * Runs requests against the BoardGameGeek client. Each `call()` is an
 * independent retry boundary — callers that compose multiple `call()`s
 * (e.g. base-thing lookup followed by batched expansion fetches) get
 * per-sub-request retry treatment, so a 429 on one sub-request retries
 * only that sub-request rather than re-running the whole composition.
 *
 * BGG's 202 (still preparing) responses are non-error status codes and
 * are handled inside the client — they never reach this layer as
 * exceptions.
 */
export class BggCaller {
  private readonly rateLimitRetryMs: number;
  private readonly maxRateLimitWaitMs: number;

  constructor(
    private readonly client: BggClientLike,
    private readonly logger: DriverLogger,
    options: BggCallerOptions = {},
  ) {
    this.rateLimitRetryMs = options.rateLimitRetryMs ?? 2000;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 30_000;
  }

  /**
   * Execute a request against the BGG API. On a 429 (rate-limited)
   * response, wait as long as BGG's `Retry-After` asks, or 2 seconds when it
   * names no wait, and retry once (#1082). A 429 that asks for longer than
   * the caller will wait fails at once, since asking sooner would only be
   * refused again. All other errors propagate.
   */
  call<T>(request: BggRequest<T>): Observable<T> {
    return request(this.client).pipe(
      catchError((err: unknown) => {
        if (!isRateLimit(err)) {
          return throwError(() => err);
        }

        const waitMs = err.retryAfterMs ?? this.rateLimitRetryMs;

        if (waitMs > this.maxRateLimitWaitMs) {
          this.logger.warn(`BGG rate limit hit; BGG asked for ${waitMs}ms, longer than ${this.maxRateLimitWaitMs}ms`);
          return throwError(() => err);
        }

        this.logger.warn(`BGG rate limit hit; retrying in ${waitMs}ms`);

        return timer(waitMs).pipe(switchMap(() => request(this.client)));
      }),
    );
  }
}

/** A 429 as the client throws it (#880). */
function isRateLimit(err: unknown): err is BggHttpError {
  return err instanceof BggHttpError && err.status === TOO_MANY_REQUESTS;
}
