import * as proto from '@boardgamesempire/proto-gateway';

/**
 * A DataGateway's wait in milliseconds, or undefined when it gave no usable
 * one: missing, not finite or not positive. Every consumer reads a wait
 * through this, so they all agree on which waits count (#925).
 */
export function usableRetryAfterMs(retryAfterMs: number | undefined): number | undefined {
  return retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : undefined;
}

/**
 * A DataGateway's wait as whole seconds, rounded up so no one asks again too
 * soon, or undefined when it gave no usable wait (#925).
 */
export function retryAfterSeconds(retryAfterMs: number | undefined): number | undefined {
  const usable = usableRetryAfterMs(retryAfterMs);

  return usable === undefined ? undefined : Math.ceil(usable / 1000);
}

/**
 * A DataGateway answered that its upstream's budget is spent (#925). It is
 * healthy, so a consumer never counts this toward auto-disable: it waits and
 * asks again.
 */
export class DataGatewayThrottledError extends Error {
  /** How long the DataGateway asked to wait, or undefined when it gave no usable time. */
  readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined) {
    const seconds = retryAfterSeconds(retryAfterMs);
    const when = seconds === undefined ? 'later' : `in ${seconds} seconds`;
    super(`The DataGateway is busy and asked to be tried again ${when}.`);
    this.name = 'DataGatewayThrottledError';
    this.retryAfterMs = usableRetryAfterMs(retryAfterMs);
  }
}

/**
 * The throttled error for an answer that says RATE_LIMITED and carries no
 * game, or undefined for any other answer: with a game it was found. A wait
 * that isn't usable is no time given (#925).
 */
export function throttledError(answer: {
  status: proto.ResultStatus;
  retryAfterMs?: number;
  game?: unknown;
}): DataGatewayThrottledError | undefined {
  if (answer.status !== proto.ResultStatus.RESULT_STATUS_RATE_LIMITED || answer.game) {
    return undefined;
  }

  return new DataGatewayThrottledError(answer.retryAfterMs);
}
