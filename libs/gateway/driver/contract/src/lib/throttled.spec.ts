import * as proto from '@boardgamesempire/proto-gateway';
import { DataGatewayThrottledError, retryAfterSeconds, throttledError, usableRetryAfterMs } from './throttled.js';

/**
 * A throttled DataGateway answers RATE_LIMITED in-band, with how long to wait
 * in milliseconds. The answer is never a failure, and a missing or nonsense
 * wait reads as "later", never as NaN or "in 0 seconds" (#925).
 */
describe('throttledError', () => {
  const RATE_LIMITED = proto.ResultStatus.RESULT_STATUS_RATE_LIMITED;

  it('reads a throttled answer as the throttled error, with its wait', () => {
    const error = throttledError({ status: RATE_LIMITED, retryAfterMs: 30_000 });

    expect(error).toBeInstanceOf(DataGatewayThrottledError);
    expect(error?.retryAfterMs).toBe(30_000);
    expect(error?.message).toBe('The DataGateway is busy and asked to be tried again in 30 seconds.');
  });

  it('rounds a wait of part of a second up', () => {
    expect(throttledError({ status: RATE_LIMITED, retryAfterMs: 1_500 })?.message).toBe(
      'The DataGateway is busy and asked to be tried again in 2 seconds.',
    );
  });

  it.each([1_000, 400])('says "1 second", not "1 seconds", for a wait of %i ms', (retryAfterMs) => {
    expect(throttledError({ status: RATE_LIMITED, retryAfterMs })?.message).toBe(
      'The DataGateway is busy and asked to be tried again in 1 second.',
    );
  });

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('reads a wait that is %s as no time given', (_label, retryAfterMs) => {
    const error = throttledError({ status: RATE_LIMITED, retryAfterMs });

    expect(error).toBeInstanceOf(DataGatewayThrottledError);
    expect(error?.retryAfterMs).toBeUndefined();
    expect(error?.message).toBe('The DataGateway is busy and asked to be tried again later.');
  });

  it.each([proto.ResultStatus.RESULT_STATUS_RESULT, proto.ResultStatus.RESULT_STATUS_ERROR])(
    'is undefined for an answer that is not throttled (%s)',
    (status) => {
      expect(throttledError({ status, retryAfterMs: 30_000 })).toBeUndefined();
    },
  );

  // With a game it was found, whatever the status says (#925).
  it('is undefined for a RATE_LIMITED answer that carries a game', () => {
    const game = { externalId: '13', title: 'Catan' } as proto.GameData;

    expect(throttledError({ status: RATE_LIMITED, retryAfterMs: 30_000, game })).toBeUndefined();
  });
});

/**
 * One rule for which waits count, shared by the import path and the search
 * socket, so the two never disagree about the same answer (#925).
 */
describe('usableRetryAfterMs and retryAfterSeconds', () => {
  it('keeps a positive wait, in seconds rounded up', () => {
    expect(usableRetryAfterMs(1_500)).toBe(1_500);
    expect(retryAfterSeconds(1_500)).toBe(2);
    expect(retryAfterSeconds(30_000)).toBe(30);
  });

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('reads a wait that is %s as none', (_label, retryAfterMs) => {
    expect(usableRetryAfterMs(retryAfterMs)).toBeUndefined();
    expect(retryAfterSeconds(retryAfterMs)).toBeUndefined();
  });
});
