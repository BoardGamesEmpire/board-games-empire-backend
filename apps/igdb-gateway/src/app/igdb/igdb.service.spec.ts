import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AxiosError, AxiosHeaders } from 'axios';
import { firstValueFrom } from 'rxjs';
import type { IgdbGame } from '../types';
import { IGDB_CLIENT } from './constants';
import { IgdbAuthService } from './igdb-auth.service';
import { IGDBService, type IgdbRequest } from './igdb.service';
import type { IGDBClient } from './interfaces/';

describe('IGDBService', () => {
  let service: IGDBService;
  let mockClient: jest.Mocked<Pick<IGDBClient, 'request'>>;
  let mockAuthService: jest.Mocked<IgdbAuthService>;

  const MOCK_GAMES: IgdbGame[] = [{ id: 1, name: 'Hades' }];

  beforeEach(async () => {
    mockClient = { request: jest.fn() };

    mockAuthService = {
      fetchAccessToken: jest.fn().mockResolvedValue({
        access_token: 'new-token',
        expires_in: 3600,
        token_type: 'bearer',
      }),
    } as jest.Mocked<IgdbAuthService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IGDBService,
        { provide: IGDB_CLIENT, useValue: mockClient },
        { provide: IgdbAuthService, useValue: mockAuthService },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue({
              clientId: 'test-client-id',
              clientSecret: 'test-client-secret',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<IGDBService>(IGDBService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('call', () => {
    it('executes the provided request function with the current client', async () => {
      const request = makeRequest(MOCK_GAMES);
      await firstValueFrom(service.call(request));
      expect(request).toHaveBeenCalledWith(mockClient);
    });

    it('resolves with the value returned by the request function', async () => {
      const result = await firstValueFrom(service.call(makeRequest(MOCK_GAMES)));
      expect(result).toEqual(MOCK_GAMES);
    });

    it('propagates non-401 errors without refreshing the token', async () => {
      const networkError = new Error('ECONNREFUSED');
      await expect(firstValueFrom(service.call(makeFailingRequest(networkError)))).rejects.toThrow('ECONNREFUSED');
      expect(mockAuthService.fetchAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('call — 401 retry', () => {
    it('refreshes the token on a 401 and retries the request once', async () => {
      const request = makeRequest401ThenSuccess(MOCK_GAMES);
      const result = await firstValueFrom(service.call(request));

      expect(mockAuthService.fetchAccessToken).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(result).toEqual(MOCK_GAMES);
    });

    it('throws if the request fails with 401 again after a refresh', async () => {
      const request: IgdbRequest<IgdbGame[]> = jest.fn().mockRejectedValue(make401Error());

      await expect(firstValueFrom(service.call(request))).rejects.toThrow();
      expect(mockAuthService.fetchAccessToken).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('refreshes the token using credentials from ConfigService', async () => {
      const request = makeRequest401ThenSuccess(MOCK_GAMES);
      await firstValueFrom(service.call(request));

      expect(mockAuthService.fetchAccessToken).toHaveBeenCalledWith({
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
      });
    });
  });

  describe('call — concurrent 401 race condition', () => {
    it('issues only one token refresh when concurrent calls both receive 401', async () => {
      const requestA = makeRequest401ThenSuccess<string>('result-a');
      const requestB = makeRequest401ThenSuccess<string>('result-b');

      const [a, b] = await Promise.all([
        firstValueFrom(service.call(requestA)),
        firstValueFrom(service.call(requestB)),
      ]);

      expect(mockAuthService.fetchAccessToken).toHaveBeenCalledTimes(1);
      expect(a).toBe('result-a');
      expect(b).toBe('result-b');
    });

    it('clears the refresh mutex after the refresh completes', async () => {
      const requestA = makeRequest401ThenSuccess(MOCK_GAMES);
      await firstValueFrom(service.call(requestA));
      expect(mockAuthService.fetchAccessToken).toHaveBeenCalledTimes(1);

      const requestB = makeRequest401ThenSuccess(MOCK_GAMES);
      await firstValueFrom(service.call(requestB));
      expect(mockAuthService.fetchAccessToken).toHaveBeenCalledTimes(2);
    });
  });
});

function make401Error(): AxiosError {
  const err = new AxiosError('Unauthorized');
  err.response = {
    status: HttpStatus.UNAUTHORIZED,
    statusText: 'Unauthorized',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

function makeRequest<T>(result: T): IgdbRequest<T> {
  return jest.fn().mockResolvedValue(result);
}

function makeFailingRequest(error: Error): IgdbRequest<never> {
  return jest.fn().mockRejectedValue(error);
}

function makeRequest401ThenSuccess<T>(result: T): IgdbRequest<T> {
  return jest.fn().mockRejectedValueOnce(make401Error()).mockResolvedValue(result);
}
