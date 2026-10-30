import { Test, TestingModule } from '@nestjs/testing';
import { Http } from '@status/codes';
import { BggApiError, BggClient, BggClientError } from 'bgg-ts-client';
import { defer, firstValueFrom, of, throwError } from 'rxjs';
import type { BggThing } from '../types';
import { BggRequest, BggService } from './bgg.service';
import { BGG_CLIENT } from './constants';
import type { BggClientLike } from './interfaces';

/**
 * The network under the real `bgg-ts-client`, whose fetcher goes through
 * isomorphic-unfetch.
 */
const mockFetch = jest.fn<Promise<Response>, [string]>();
jest.mock('isomorphic-unfetch', () => (url: string) => mockFetch(url));

describe('BggService', () => {
  let service: BggService;
  let mockClient: BggClientLike;

  const MOCK_THINGS: BggThing[] = [{ id: 174430, type: 'boardgame' }];

  beforeEach(async () => {
    mockClient = {
      thing: { query: jest.fn() },
      search: { query: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [BggService, { provide: BGG_CLIENT, useValue: mockClient }],
    }).compile();

    service = module.get<BggService>(BggService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('call', () => {
    it('subscribes to the Observable returned by the request function', async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(of(MOCK_THINGS));

      await firstValueFrom(service.call(request));

      expect(request).toHaveBeenCalledWith(mockClient);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('emits the value produced by the request', async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(of(MOCK_THINGS));

      const result = await firstValueFrom(service.call(request));

      expect(result).toEqual(MOCK_THINGS);
    });

    it("propagates errors that are not the client's without retrying", async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(throwError(() => new Error('boom')));

      await expect(firstValueFrom(service.call(request))).rejects.toThrow('boom');
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('propagates client errors with non-429 status codes without retrying', async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(throwError(() => clientError(Http.NotFound)));

      await expect(firstValueFrom(service.call(request))).rejects.toBeInstanceOf(BggClientError);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('call — 429 (rate limited) retry', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('re-invokes the request factory once on a 429 response', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => clientError(Http.TooManyRequests)))
        .mockReturnValueOnce(of(MOCK_THINGS));

      const result$ = firstValueFrom(service.call(request));
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
        .mockReturnValueOnce(throwError(() => clientError(Http.TooManyRequests)))
        .mockReturnValueOnce(of(MOCK_THINGS));

      const result$ = firstValueFrom(service.call(request));

      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1999);
      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result$).resolves.toEqual(MOCK_THINGS);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('throws if the retried request also fails with 429', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValue(throwError(() => clientError(Http.TooManyRequests)));

      const result$ = firstValueFrom(service.call(request));
      const rejection = expect(result$).rejects.toBeInstanceOf(BggClientError);
      await jest.runAllTimersAsync();

      await rejection;
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 429 followed by a non-retryable error — the second error propagates', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => clientError(Http.TooManyRequests)))
        .mockReturnValueOnce(throwError(() => new Error('boom')));

      const result$ = firstValueFrom(service.call(request));
      const rejection = expect(result$).rejects.toThrow('boom');
      await jest.runAllTimersAsync();

      await rejection;
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('retries a 429 from the real client, which throws no Axios error (#880)', async () => {
      const client = BggClient.Create({ apiKey: 'test-key' }) as unknown as BggClientLike;
      const module = await Test.createTestingModule({
        providers: [BggService, { provide: BGG_CLIENT, useValue: client }],
      }).compile();
      mockFetch
        .mockResolvedValueOnce(new Response('Rate limit exceeded', { status: Http.TooManyRequests }))
        .mockResolvedValueOnce(new Response('<items total="0" termsofuse=""></items>'));

      const result$ = firstValueFrom(
        module.get(BggService).call((bgg) => defer(() => bgg.search.query({ query: 'catan' }))),
      );
      await jest.runAllTimersAsync();

      await expect(result$).resolves.toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

/** An error of `status` as `bgg-ts-client` throws it. */
function clientError(status: number): BggClientError {
  return new BggClientError('thing', new BggApiError(status, 'https://boardgamegeek.com/xmlapi2/thing'));
}
