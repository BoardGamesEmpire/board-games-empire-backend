import type { Upstream } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { retryAfterSeconds, usableRetryAfterMs } from '@boardgamesempire/gateway-driver-contract';
import { Http } from '@status/codes';
import { UpstreamAccountErrorCode } from './upstream-account.constants';

/**
 * The wait a throttled answer is given when the DataGateway names no usable
 * one: a minute, as live search gives (`DEFAULT_RETRY_AFTER_SECONDS` in the
 * api's search gateway, which a lib can't import).
 */
export const DEFAULT_THROTTLED_WAIT_MS = 60_000;

/**
 * 503 `UPSTREAM_THROTTLED`: the DataGateway answered that its upstream's
 * budget is spent, so nothing was done (#1226). The body carries the wait in
 * `retryAfterMs`, milliseconds as the DataGateway gives it; the route sends
 * {@link retryAfterSeconds} as the `Retry-After` header. A wait that is
 * missing, zero or negative is no wait, read through the rule every consumer
 * of a DataGateway's wait shares (#925), and becomes
 * {@link DEFAULT_THROTTLED_WAIT_MS}.
 */
export class UpstreamThrottledException extends CodedHttpException {
  /** The wait in whole seconds, rounded up, as `Retry-After` takes it. */
  readonly retryAfterSeconds: number;

  constructor(upstream: Upstream, retryAfterMs: number | undefined) {
    const waitMs = usableRetryAfterMs(retryAfterMs) ?? DEFAULT_THROTTLED_WAIT_MS;
    const seconds = retryAfterSeconds(waitMs) ?? Math.ceil(DEFAULT_THROTTLED_WAIT_MS / 1000);
    const message =
      seconds === 1
        ? t('errors.upstream_account.throttled_one_second', { upstream })
        : t('errors.upstream_account.throttled', { upstream, seconds });

    super(Http.ServiceUnavailable, UpstreamAccountErrorCode.Throttled, message, { fields: { retryAfterMs: waitMs } });
    this.retryAfterSeconds = seconds;
  }
}
