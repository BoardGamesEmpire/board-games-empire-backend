import type { Observable } from 'rxjs';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';

/**
 * The call's first answer, unless `signal` aborts first: the call is then
 * dropped, and the abort's reason thrown.
 */
export const firstAnswer = async <T>(call: Observable<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  try {
    return await firstValueFrom(call.pipe(takeUntil(fromEvent(signal, 'abort'))));
  } catch (err) {
    signal.throwIfAborted();
    throw err;
  }
};
