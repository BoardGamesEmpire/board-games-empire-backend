import type { DriverLogger } from '@boardgamesempire/gateway-driver-contract';
import {
  createFakeFetch,
  type FakeFetch,
  type FakeFetchReply,
} from '@boardgamesempire/gateway-driver-contract-testing';
import { firstValueFrom } from 'rxjs';
import type { IGDBClient, IgdbRequest } from './client/igdb-client.interface';
import { IgdbHttpError } from './client/igdb-http.error';
import { IgdbQuery } from './client/igdb-query';
import { IgdbCaller } from './igdb-caller';
import type { IgdbGame } from './types';

const TOKEN_URL = 'http://127.0.0.1:4010/oauth2/token';
const MOCK_GAMES: IgdbGame[] = [{ id: 1, name: 'Hades' }];

const tokenReply = (accessToken: string): FakeFetchReply => ({
  body: JSON.stringify({ access_token: accessToken, expires_in: 3600, token_type: 'bearer' }),
});

const isTokenRequest = (url: URL) => url.href.startsWith(TOKEN_URL);

describe('IgdbCaller', () => {
  let fetch: FakeFetch;
  let logger: jest.Mocked<DriverLogger>;
  let caller: IgdbCaller;

  const tokenRequests = () => fetch.requests.filter(({ url }) => isTokenRequest(url));

  /** A caller over `fetch`, its first token fetched as the app's boot would. */
  const started = async (over: FakeFetch) => {
    const started = new IgdbCaller({
      fetch: over,
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      tokenUrl: TOKEN_URL,
      logger,
    });
    await started.start();

    return started;
  };

  beforeEach(async () => {
    let issued = 0;
    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    fetch = createFakeFetch(({ url }) =>
      isTokenRequest(url) ? tokenReply(`token-${++issued}`) : { body: JSON.stringify(MOCK_GAMES) },
    );
    caller = await started(fetch);
  });

  describe('start', () => {
    it('fetches the first token from the configured token URL, with the configured credentials', () => {
      expect(tokenRequests()).toHaveLength(1);
      expect(Object.fromEntries(tokenRequests()[0].url.searchParams)).toEqual({
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        grant_type: 'client_credentials',
      });
    });
  });

  describe('call', () => {
    it('executes the provided request function with a client and a signal', async () => {
      const request = makeRequest(MOCK_GAMES);

      await firstValueFrom(caller.call(request));

      expect(request).toHaveBeenCalledWith(expect.any(IgdbQuery), expect.any(AbortSignal));
    });

    it('builds the client with the current access token', async () => {
      await firstValueFrom(caller.call((client, signal) => client.fields('id').request('/games', signal)));

      expect(fetch.requests.at(-1)?.headers['authorization']).toBe('Bearer token-1');
    });

    it('builds a fresh client per call so concurrent requests cannot share builder state', async () => {
      const clientsSeen: IGDBClient[] = [];
      const request: IgdbRequest<IgdbGame[]> = jest.fn(async (client) => {
        clientsSeen.push(client);
        return MOCK_GAMES;
      });

      await Promise.all([firstValueFrom(caller.call(request)), firstValueFrom(caller.call(request))]);

      expect(clientsSeen).toHaveLength(2);
      expect(clientsSeen[0]).not.toBe(clientsSeen[1]);
    });

    it('resolves with the value returned by the request function', async () => {
      await expect(firstValueFrom(caller.call(makeRequest(MOCK_GAMES)))).resolves.toEqual(MOCK_GAMES);
    });

    it('propagates errors other than a 401 or a 429 without refreshing the token or retrying', async () => {
      const request = makeFailingRequest(new IgdbHttpError(500, '/games'));

      await expect(firstValueFrom(caller.call(request))).rejects.toMatchObject({ status: 500 });
      expect(request).toHaveBeenCalledTimes(1);
      expect(tokenRequests()).toHaveLength(1);
    });

    it('aborts the request when unsubscribed (#1082)', () => {
      let signal: AbortSignal | undefined;

      caller
        .call((_client, given) => {
          signal = given;
          return new Promise<never>(() => undefined);
        })
        .subscribe()
        .unsubscribe();

      expect(signal?.aborted).toBe(true);
    });
  });

  describe('call — 401 retry', () => {
    it('refreshes the token on a 401 and retries the request once, with the new token', async () => {
      const tokensSeen: string[] = [];
      const request: IgdbRequest<IgdbGame[]> = jest.fn(async (client, signal) => {
        const answer = await client.fields('id').request<IgdbGame>('/games', signal);
        tokensSeen.push(fetch.requests.at(-1)?.headers['authorization'] ?? '');

        if (tokensSeen.length === 1) {
          throw new IgdbHttpError(401, '/games');
        }

        return answer.data;
      });

      await expect(firstValueFrom(caller.call(request))).resolves.toEqual(MOCK_GAMES);

      expect(tokenRequests()).toHaveLength(2);
      expect(tokensSeen).toEqual(['Bearer token-1', 'Bearer token-2']);
    });

    it('fails if the request fails with 401 again after a refresh, without a second refresh', async () => {
      const request: IgdbRequest<IgdbGame[]> = jest.fn().mockRejectedValue(new IgdbHttpError(401, '/games'));

      await expect(firstValueFrom(caller.call(request))).rejects.toMatchObject({ status: 401 });
      expect(tokenRequests()).toHaveLength(2);
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  describe('call — 429 retry', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('waits a second, then retries the request once', async () => {
      const request: IgdbRequest<IgdbGame[]> = jest
        .fn()
        .mockRejectedValueOnce(new IgdbHttpError(429, '/games'))
        .mockResolvedValue(MOCK_GAMES);

      const result$ = firstValueFrom(caller.call(request));

      await jest.advanceTimersByTimeAsync(999);
      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);

      await expect(result$).resolves.toEqual(MOCK_GAMES);
      expect(request).toHaveBeenCalledTimes(2);
      expect(tokenRequests()).toHaveLength(1);
    });
  });

  describe('call — concurrent 401 race condition', () => {
    it('issues only one token refresh when concurrent calls both receive 401', async () => {
      let releaseToken: (reply: FakeFetchReply) => void = () => undefined;
      let tokensIssued = 0;
      const held = createFakeFetch(({ url }) => {
        if (!isTokenRequest(url)) {
          return { body: '[]' };
        }

        tokensIssued += 1;
        // The refresh's token is held until both calls have seen their 401.
        return tokensIssued === 1 ? tokenReply('token-1') : new Promise((resolve) => (releaseToken = resolve));
      });
      const racing = await started(held);

      const requestA = makeRequest401ThenSuccess<string>('result-a');
      const requestB = makeRequest401ThenSuccess<string>('result-b');
      const answers = Promise.all([firstValueFrom(racing.call(requestA)), firstValueFrom(racing.call(requestB))]);

      await new Promise((resolve) => setTimeout(resolve, 5));
      releaseToken(tokenReply('token-2'));

      await expect(answers).resolves.toEqual(['result-a', 'result-b']);
      expect(held.requests.filter(({ url }) => isTokenRequest(url))).toHaveLength(2);
    });

    it('clears the refresh mutex after the refresh completes', async () => {
      await firstValueFrom(caller.call(makeRequest401ThenSuccess(MOCK_GAMES)));
      expect(tokenRequests()).toHaveLength(2);

      await firstValueFrom(caller.call(makeRequest401ThenSuccess(MOCK_GAMES)));
      expect(tokenRequests()).toHaveLength(3);
    });
  });
});

function makeRequest<T>(result: T): IgdbRequest<T> {
  return jest.fn().mockResolvedValue(result);
}

function makeFailingRequest(error: Error): IgdbRequest<never> {
  return jest.fn().mockRejectedValue(error);
}

function makeRequest401ThenSuccess<T>(result: T): IgdbRequest<T> {
  return jest.fn().mockRejectedValueOnce(new IgdbHttpError(401, '/games')).mockResolvedValue(result);
}
