import { CodedHttpException, t } from '@bge/i18n';
import type { ContextType, ExecutionContext } from '@nestjs/common';
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
 *
 * Each guard counts only its own {@link transport}. Nest runs global guards on
 * a gateway's frames too, and this one would count a frame by the request IP a
 * socket doesn't have, so every socket would share one count. A frame is
 * `WsThrottlerGuard`'s to count, by its user or socket (#510).
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  /** The transport whose requests this guard counts. */
  protected readonly transport: ContextType = 'http';

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== this.transport;
  }

  protected override async throwThrottlingException(): Promise<void> {
    throw new CodedHttpException(Http.TooManyRequests, 'RATE_LIMITED', t('errors.request.rate_limited'));
  }
}
