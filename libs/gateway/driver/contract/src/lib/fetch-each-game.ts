import * as proto from '@boardgamesempire/proto-gateway';
import { concatMap, defer, from, map, Observable, of, take, throwError, throwIfEmpty } from 'rxjs';
import { GRPC_STATUS_INVALID_ARGUMENT, grpcStatusError } from './driver-observables.js';

/**
 * FetchGames served one FetchGame at a time, for a driver whose upstream has
 * no batch call (#925). Each distinct external ID answers once, in the order
 * first named, unless a fetch fails first. More distinct IDs than `maxIds`,
 * the limit the driver declares, are refused with INVALID_ARGUMENT before
 * any fetch, never truncated. Once a fetch answers throttled, every later ID
 * answers throttled with the same wait, without asking the upstream again. A
 * fetch that fails errors the stream: the answers already sent stand, and
 * the IDs not yet answered get none.
 */
export function fetchEachGame(
  request: proto.FetchGamesRequest,
  fetchGame: (request: proto.FetchGameRequest) => Observable<proto.FetchGameResponse>,
  maxIds: number,
): Observable<proto.FetchGamesResponse> {
  return defer(() => {
    const externalIds = [...new Set(request.externalIds)];

    if (externalIds.length > maxIds) {
      return throwError(() =>
        grpcStatusError(
          GRPC_STATUS_INVALID_ARGUMENT,
          `FetchGames takes at most ${maxIds} external IDs; this call named ${externalIds.length}`,
        ),
      );
    }

    let throttled: proto.FetchGameResponse | undefined;

    const answer = (externalId: string, response: proto.FetchGameResponse): proto.FetchGamesResponse => ({
      ...response,
      correlationId: request.correlationId,
      externalId,
    });

    return from(externalIds).pipe(
      concatMap((externalId) => {
        if (throttled) {
          return of(answer(externalId, throttled));
        }

        return fetchGame({
          correlationId: request.correlationId,
          externalId,
          locale: request.locale,
          trafficClass: request.trafficClass,
        }).pipe(
          take(1),
          throwIfEmpty(() => new Error(`FetchGame answered nothing for external ID ${externalId}`)),
          map((response) => {
            if (response.status === proto.ResultStatus.RESULT_STATUS_RATE_LIMITED && !response.game) {
              throttled = response;
            }

            return answer(externalId, response);
          }),
        );
      }),
    );
  });
}
