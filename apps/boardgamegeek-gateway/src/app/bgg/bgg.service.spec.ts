import { Test, TestingModule } from '@nestjs/testing';
import { Http } from '@status/codes';
import { AxiosError, AxiosHeaders } from 'axios';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { BggThing } from '../types';
import { BggRequest, BggService } from './bgg.service';
import { BGG_CLIENT } from './constants';
import type { BggClientLike } from './interfaces';

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

    it('propagates non-Axios errors without retrying', async () => {
      const request: BggRequest<BggThing[]> = jest.fn().mockReturnValue(throwError(() => new Error('boom')));

      await expect(firstValueFrom(service.call(request))).rejects.toThrow('boom');
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('propagates Axios errors with non-429 status codes without retrying', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValue(throwError(() => makeAxiosError(Http.NotFound)));

      await expect(firstValueFrom(service.call(request))).rejects.toBeInstanceOf(AxiosError);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('call — 429 (rate limited) retry', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('re-invokes the request factory once on a 429 response', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => makeAxiosError(Http.TooManyRequests)))
        .mockReturnValueOnce(of(MOCK_THINGS));

      const result$ = firstValueFrom(service.call(request));
      await jest.runAllTimersAsync();
      const result = await result$;

      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, mockClient);
      expect(request).toHaveBeenNthCalledWith(2, mockClient);
      expect(result).toEqual(MOCK_THINGS);
    });

    it('honors a numeric Retry-After header (seconds) for the backoff delay', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => makeAxiosError(Http.TooManyRequests, { 'retry-after': '3' })))
        .mockReturnValueOnce(of(MOCK_THINGS));

      const result$ = firstValueFrom(service.call(request));

      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2999);
      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result$).resolves.toEqual(MOCK_THINGS);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('falls back to the default 2000ms when no Retry-After header is present', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => makeAxiosError(Http.TooManyRequests)))
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
        .mockReturnValue(throwError(() => makeAxiosError(Http.TooManyRequests)));

      const result$ = firstValueFrom(service.call(request));
      const rejection = expect(result$).rejects.toBeInstanceOf(AxiosError);
      await jest.runAllTimersAsync();

      await rejection;
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 429 followed by a non-retryable error — the second error propagates', async () => {
      const request: BggRequest<BggThing[]> = jest
        .fn()
        .mockReturnValueOnce(throwError(() => makeAxiosError(Http.TooManyRequests)))
        .mockReturnValueOnce(throwError(() => new Error('boom')));

      const result$ = firstValueFrom(service.call(request));
      const rejection = expect(result$).rejects.toThrow('boom');
      await jest.runAllTimersAsync();

      await rejection;
      expect(request).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * Builds an AxiosError matching the shape the service inspects via
 * `isAxiosError(err)` + `err.response?.status`.
 */
function makeAxiosError(status: number, headers: Record<string, string> = {}): AxiosError {
  const axiosHeaders = new AxiosHeaders(headers);
  const error = new AxiosError(`Status ${status}`, String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: axiosHeaders,
    config: { headers: axiosHeaders },
    data: undefined,
  });
  return error;
}
