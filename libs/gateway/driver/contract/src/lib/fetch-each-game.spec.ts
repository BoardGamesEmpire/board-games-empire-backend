import * as proto from '@boardgamesempire/proto-gateway';
import { EMPTY, lastValueFrom, Observable, of, throwError, toArray } from 'rxjs';
import { GRPC_STATUS_INVALID_ARGUMENT } from './driver-observables.js';
import { fetchEachGame } from './fetch-each-game.js';

const {
  RESULT_STATUS_RESULT: RESULT,
  RESULT_STATUS_ERROR: ERROR,
  RESULT_STATUS_RATE_LIMITED: RATE_LIMITED,
} = proto.ResultStatus;

const game = (externalId: string) => ({ externalId, title: externalId }) as proto.GameData;

/** A fetchGame that finds `found`, throttles `throttled` with its wait, and answers every other id not found. */
function fakeFetchGame({
  found = [] as string[],
  throttled = {} as Record<string, number>,
  failing = [] as string[],
} = {}) {
  return jest.fn((request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> => {
    const { correlationId, externalId } = request;

    if (failing.includes(externalId)) {
      return throwError(() => new Error(`upstream failed on ${externalId}`));
    }
    if (externalId in throttled) {
      return of({ correlationId, status: RATE_LIMITED, retryAfterMs: throttled[externalId] });
    }
    if (found.includes(externalId)) {
      return of({ correlationId, status: RESULT, game: game(externalId) });
    }
    return of({ correlationId, status: ERROR, message: `No game found for externalId ${externalId}` });
  });
}

const request = (externalIds: string[], overrides: Partial<proto.FetchGamesRequest> = {}): proto.FetchGamesRequest => ({
  correlationId: 'batch-1',
  externalIds,
  ...overrides,
});

const collect = <T>(stream: Observable<T>) => lastValueFrom(stream.pipe(toArray()));

/**
 * FetchGames answers each distinct id once, refuses more ids than the
 * DataGateway declared rather than truncating, and stops asking an upstream
 * that throttled it (#925).
 */
describe('fetchEachGame', () => {
  it('answers each distinct id once, in order, asking with the batch’s locale and traffic class', async () => {
    const fetchGame = fakeFetchGame({ found: ['1', '2'] });

    const answers = await collect(
      fetchEachGame(
        request(['1', '2', '1'], { locale: 'de', trafficClass: proto.TrafficClass.TRAFFIC_CLASS_BACKGROUND }),
        fetchGame,
        50,
      ),
    );

    expect(answers.map((answer) => answer.externalId)).toEqual(['1', '2']);
    expect(answers).toEqual([
      { correlationId: 'batch-1', externalId: '1', status: RESULT, game: game('1') },
      { correlationId: 'batch-1', externalId: '2', status: RESULT, game: game('2') },
    ]);
    expect(fetchGame).toHaveBeenCalledTimes(2);
    expect(fetchGame).toHaveBeenCalledWith({
      correlationId: 'batch-1',
      externalId: '1',
      locale: 'de',
      trafficClass: proto.TrafficClass.TRAFFIC_CLASS_BACKGROUND,
    });
  });

  it('completes with no answers, asking nothing, for no ids', async () => {
    const fetchGame = fakeFetchGame();

    await expect(collect(fetchEachGame(request([]), fetchGame, 50))).resolves.toEqual([]);
    expect(fetchGame).not.toHaveBeenCalled();
  });

  it('refuses more distinct ids than its limit with INVALID_ARGUMENT, asking nothing', async () => {
    const fetchGame = fakeFetchGame({ found: ['1', '2', '3'] });

    const error = await collect(fetchEachGame(request(['1', '2', '3']), fetchGame, 2)).catch((err: unknown) => err);

    expect(GRPC_STATUS_INVALID_ARGUMENT).toBe(3);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: 3,
      message: 'FetchGames takes at most 2 external IDs; this call named 3',
    });
    expect(fetchGame).not.toHaveBeenCalled();
  });

  it('counts a repeated id once against its limit', async () => {
    const answers = await collect(fetchEachGame(request(['1', '1', '2']), fakeFetchGame({ found: ['1', '2'] }), 2));

    expect(answers.map((answer) => answer.externalId)).toEqual(['1', '2']);
  });

  it('answers an id it can’t find with no game, and the status the fetch gave', async () => {
    const answers = await collect(fetchEachGame(request(['999']), fakeFetchGame(), 50));

    expect(answers).toEqual([
      { correlationId: 'batch-1', externalId: '999', status: ERROR, message: 'No game found for externalId 999' },
    ]);
  });

  it('answers every later id throttled, with the same wait and without asking, once a fetch is throttled', async () => {
    const fetchGame = fakeFetchGame({ found: ['1', '3'], throttled: { '2': 5_000 } });

    const answers = await collect(fetchEachGame(request(['1', '2', '3']), fetchGame, 50));

    expect(answers).toEqual([
      expect.objectContaining({ externalId: '1', status: RESULT, game: game('1') }),
      { correlationId: 'batch-1', externalId: '2', status: RATE_LIMITED, retryAfterMs: 5_000 },
      { correlationId: 'batch-1', externalId: '3', status: RATE_LIMITED, retryAfterMs: 5_000 },
    ]);
    expect(fetchGame).not.toHaveBeenCalledWith(expect.objectContaining({ externalId: '3' }));
  });

  it('keeps the answers already sent, then errors, when a fetch fails', async () => {
    const answers: proto.FetchGamesResponse[] = [];

    const failure = await new Promise((resolve) =>
      fetchEachGame(request(['1', '2', '3']), fakeFetchGame({ found: ['1', '3'], failing: ['2'] }), 50).subscribe({
        next: (answer) => answers.push(answer),
        error: resolve,
        complete: () => resolve(undefined),
      }),
    );

    expect(answers.map((answer) => answer.externalId)).toEqual(['1']);
    expect(failure).toEqual(new Error('upstream failed on 2'));
  });

  // Each distinct id answers exactly once: a fetch that answers nothing, or
  // more than once, breaks that, so the first answer counts and none is an error.
  it('errors rather than leave an id unanswered when a fetch answers nothing', async () => {
    const error = await collect(fetchEachGame(request(['1']), () => EMPTY, 50)).catch((err: unknown) => err);

    expect(error).toEqual(new Error('FetchGame answered nothing for external ID 1'));
  });

  it('takes a fetch’s first answer only', async () => {
    const twice = (): Observable<proto.FetchGameResponse> =>
      of(
        { correlationId: 'c', status: RESULT, game: game('1') },
        { correlationId: 'c', status: ERROR, message: 'again' },
      );

    const answers = await collect(fetchEachGame(request(['1']), twice, 50));

    expect(answers).toEqual([expect.objectContaining({ externalId: '1', status: RESULT })]);
  });
});
