import { CodedHttpException, t } from '@bge/i18n';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Http } from '@status/codes';

/**
 * The app's throttler tiers, refusing with a coded 429 whose copy comes from
 * the catalog (#527). The base guard throws a `ThrottlerException` whose body is
 * the English string "ThrottlerException: Too Many Requests": a class name
 * shown to a user, untranslatable, and with no code to branch on.
 *
 * Only the refusal changes. Counting, tracking and the headers the base guard
 * sets before it throws, `Retry-After` among them, are its own. The code,
 * `RATE_LIMITED`, is the one `/api/auth`'s own 429 already carries, so a client
 * branches on a rate limit by the same code on every route (#1260). The copy
 * says what was limited: requests here, sign-in attempts on `/api/auth`, whose
 * limiter has its own window.
 *
 * Registered app-wide in place of `ThrottlerGuard`, and the base of
 * `WsThrottlerGuard`, so both transports refuse alike.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(): Promise<void> {
    throw new CodedHttpException(Http.TooManyRequests, 'RATE_LIMITED', t('errors.request.rate_limited'));
  }
}
