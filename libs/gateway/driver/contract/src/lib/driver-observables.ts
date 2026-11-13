import { Observable, throwError } from 'rxjs';

/** gRPC's status code for a request the server refuses as malformed, such as too many IDs (#925). */
export const GRPC_STATUS_INVALID_ARGUMENT = 3;

/** gRPC's status code for a call the server doesn't serve. */
export const GRPC_STATUS_UNIMPLEMENTED = 12;

/**
 * An error carrying a gRPC status code, which the shared gRPC controller
 * sends as the call's status (#1082). A driver refuses a call with one, as
 * FetchGames refuses too many IDs with INVALID_ARGUMENT (#925).
 */
export const grpcStatusError = (code: number, message: string): Error & { code: number } =>
  Object.assign(new Error(message), { code });

/**
 * What a driver answers for an operation it doesn't serve. A DataGateway
 * declares the operations it serves and the server calls no other (#711,
 * #718), so this answers only a request that ignored `describe`. The error
 * carries gRPC's code, which the shared gRPC controller sends as the call's
 * status (#1082).
 */
export const unsupportedOperation = (rpc: string): Observable<never> =>
  throwError(() => grpcStatusError(GRPC_STATUS_UNIMPLEMENTED, `${rpc} is not served by this DataGateway`));

/**
 * An upstream call as an Observable. Each subscription runs the call afresh,
 * so subscribing again retries it. Unsubscribing before the
 * call settles aborts its signal, so a cancelled search or fetch stops
 * reaching the upstream, and what the call settles with afterwards is dropped
 * (#1082).
 */
export function fromAbortable<T>(run: (signal: AbortSignal) => Promise<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    const controller = new AbortController();
    let settled = false;

    run(controller.signal).then(
      (value) => {
        settled = true;

        if (!subscriber.closed) {
          subscriber.next(value);
          subscriber.complete();
        }
      },
      (err: unknown) => {
        settled = true;

        if (!subscriber.closed) {
          subscriber.error(err);
        }
      },
    );

    return () => {
      if (!settled) {
        controller.abort();
      }
    };
  });
}
