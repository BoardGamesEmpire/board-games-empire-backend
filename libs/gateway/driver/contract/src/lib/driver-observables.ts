import { Observable, throwError } from 'rxjs';

/** gRPC's status code for a call the server doesn't serve. */
export const GRPC_STATUS_UNIMPLEMENTED = 12;

/**
 * What a driver answers for an operation it doesn't serve. A DataGateway
 * declares the operations it serves and the server calls no other (#711,
 * #718), so this answers only a request that ignored `describe`. The error
 * carries gRPC's code, which the shared gRPC controller sends as the call's
 * status (#1082).
 */
export const unsupportedOperation = (rpc: string): Observable<never> =>
  throwError(() =>
    Object.assign(new Error(`${rpc} is not served by this DataGateway`), { code: GRPC_STATUS_UNIMPLEMENTED }),
  );

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
