import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { fromAbortable, GRPC_STATUS_UNIMPLEMENTED, unsupportedOperation } from './driver-observables.js';

/** A promise and the functions that settle it, for settling it from a test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * A driver's upstream call as an Observable: unsubscribing must stop the
 * call, so a cancelled search or fetch stops reaching the upstream (#1082).
 */
describe('fromAbortable', () => {
  it('runs the call once per subscription, and not before', async () => {
    const run = jest.fn(async () => 'answer');
    const call$ = fromAbortable(run);

    expect(run).not.toHaveBeenCalled();

    await firstValueFrom(call$);
    await firstValueFrom(call$);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('emits what the call resolves with, then completes', async () => {
    await expect(lastValueFrom(fromAbortable(async () => 'answer').pipe(toArray()))).resolves.toEqual(['answer']);
  });

  it('errors with what the call rejects with', async () => {
    const failure = new Error('BGG answered 502');

    await expect(firstValueFrom(fromAbortable(async () => Promise.reject(failure)))).rejects.toBe(failure);
  });

  it('aborts the signal on unsubscribe, and drops the late result', async () => {
    const answer = deferred<string>();
    let signal: AbortSignal | undefined;
    const next = jest.fn();
    const error = jest.fn();

    const subscription = fromAbortable((given) => {
      signal = given;
      return answer.promise;
    }).subscribe({ next, error });

    expect(signal?.aborted).toBe(false);

    subscription.unsubscribe();
    answer.resolve('too late');
    await answer.promise;

    expect(signal?.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('drops a rejection that comes after unsubscribe', async () => {
    const answer = deferred<string>();
    const error = jest.fn();

    const subscription = fromAbortable(() => answer.promise).subscribe({ error });

    subscription.unsubscribe();
    answer.reject(new DOMException('The operation was aborted.', 'AbortError'));
    await answer.promise.catch(() => undefined);

    expect(error).not.toHaveBeenCalled();
  });
});

/**
 * A DataGateway declares the operations it serves; the server calls no
 * other, and one it does call anyway answers UNIMPLEMENTED (#1082).
 */
describe('unsupportedOperation', () => {
  it("errors with gRPC's UNIMPLEMENTED code and names the operation", async () => {
    const error = await firstValueFrom(unsupportedOperation('ListMechanics')).catch((err: unknown) => err);

    expect(GRPC_STATUS_UNIMPLEMENTED).toBe(12);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 12, message: 'ListMechanics is not served by this DataGateway' });
  });
});
