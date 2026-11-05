import type { DriverLogger } from '@boardgamesempire/gateway-driver-contract';
import { createFakeFetch, type FakeFetchReply } from '@boardgamesempire/gateway-driver-contract-testing';
import { defer, firstValueFrom, of, throwError } from 'rxjs';
import { BggCaller } from './bgg-caller';
import { createBggClient } from './client/bgg-client';
import type { BggClientLike, BggRequest } from './client/bgg-client.interface';
import { BggHttpError } from './client/bgg-http.error';
import type { BggThing } from './types';

const TOO_MANY_REQUESTS = 429;
const NOT_FOUND = 404;

describe('BggCaller', () => {
  let caller: BggCaller;
  let mockClient: BggClientLike;
  let logger: jest.Mocked<DriverLogger>;

  const MOCK_THINGS: BggThing[] = [{ id: 174430, type: 'boardgame' }];

  beforeEach(() => {
    mockClient = {
      thing: { query: jest.fn() },
      search: { query: jest.fn() },
    };
    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    caller = new BggCaller(mockClient, logger);
  });

  afterEach(() => jest.clearAllMocks());

  describe('call', () => {
    it('subscribes to the Observable returned by the request function', async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(of(MOCK_THINGS));

      await firstValueFrom(caller.call(request));

      expect(request).toHaveBeenCalledWith(mockClient);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('emits the value produced by the request', async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(of(MOCK_THINGS));

      const result = await firstValueFrom(caller.call(request));

      expect(result).toEqual(MOCK_THINGS);
    });

    it("propagates errors that are not the client's without retrying", async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(throwError(() => new Error('boom')));

      await expect(firstValueFrom(caller.call(request))).rejects.toThrow('boom');
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('propagates client errors with non-429 status codes without retrying', async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(throwError(() => clientError(NOT_FOUND)));

      await expect(firstValueFrom(caller.call(request))).rejects.toBeInstanceOf(BggHttpError);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('call — 429 (rate limited) retry', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('re-invokes the request factory once on a 429 response', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => clientError(TOO_MANY_REQUESTS)))
        .mockReturnValueOnce(of(MOCK_THINGS));

      const result$ = firstValueFrom(caller.call(request));
      await jest.runAllTimersAsync();
      const result = await result$;

      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, mockClient);
      expect(request).toHaveBeenNthCalledWith(2, mockClient);
      expect(result).toEqual(MOCK_THINGS);
    });

    it('waits 2000ms before the retry', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => clientError(TOO_MANY_REQUESTS)))
        .mockReturnValueOnce(of(MOCK_THINGS));

      const result$ = firstValueFrom(caller.call(request));

      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1999);
      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result$).resolves.toEqual(MOCK_THINGS);
      expect(request).toHaveBeenCalledTimes(2);
    });

    // BGG says when it will answer again; asking sooner is refused (#1082).
    it("waits as long as the 429's Retry-After asks before the retry", async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => clientError(TOO_MANY_REQUESTS, 10_000)))
        .mockReturnValueOnce(of(MOCK_THINGS));

      const result$ = firstValueFrom(caller.call(request));

      await jest.advanceTimersByTimeAsync(9999);
      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result$).resolves.toEqual(MOCK_THINGS);
      expect(logger.warn).toHaveBeenCalledWith('BGG rate limit hit; retrying in 10000ms');
    });

    it('fails at once, without a retry, when Retry-After asks for longer than the caller waits', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValue(throwError(() => clientError(TOO_MANY_REQUESTS, 30_001)));

      await expect(firstValueFrom(caller.call(request))).rejects.toBeInstanceOf(BggHttpError);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('throws if the retried request also fails with 429', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValue(throwError(() => clientError(TOO_MANY_REQUESTS)));

      const result$ = firstValueFrom(caller.call(request));
      const rejection = expect(result$).rejects.toBeInstanceOf(BggHttpError);
      await jest.runAllTimersAsync();

      await rejection;
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 429 followed by a non-retryable error — the second error propagates', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => clientError(TOO_MANY_REQUESTS)))
        .mockReturnValueOnce(throwError(() => new Error('boom')));

      const result$ = firstValueFrom(caller.call(request));
      const rejection = expect(result$).rejects.toThrow('boom');
      await jest.runAllTimersAsync();

      await rejection;
      expect(request).toHaveBeenCalledTimes(2);
    });

    it("retries a 429 from the driver's own client after the wait its Retry-After asks (#880, #1082)", async () => {
      const replies: FakeFetchReply[] = [
        {
          status: TOO_MANY_REQUESTS,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '3' },
          body: 'Rate limit exceeded',
        },
        { body: '<items total="0" termsofuse=""></items>' },
      ];
      const fetch = createFakeFetch(() => replies.shift() ?? {});
      const realCaller = new BggCaller(createBggClient({ fetch, apiKey: 'test-key' }), logger);

      const result$ = firstValueFrom(realCaller.call((bgg) => defer(() => bgg.search.query({ query: 'catan' }))));
      await jest.runAllTimersAsync();

      await expect(result$).resolves.toBeDefined();
      expect(fetch.requests).toHaveLength(2);
      expect(logger.warn).toHaveBeenCalledWith('BGG rate limit hit; retrying in 3000ms');
    });
  });
});

/** An error of `status` as the client throws it, with the wait a `Retry-After` asked for. */
function clientError(status: number, retryAfterMs?: number): BggHttpError {
  return new BggHttpError(status, 'https://boardgamegeek.com/xmlapi2/thing?id=1', retryAfterMs);
}
