import { deadlock, uniqueViolation } from '@bge/database/testing';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Http } from '@status/codes';
import { lastValueFrom, of, throwError } from 'rxjs';
import { TransactionDeadlockError, TransactionDeadlockInterceptor } from './transaction-deadlock.interceptor';

describe('TransactionDeadlockInterceptor', () => {
  const interceptor = new TransactionDeadlockInterceptor();
  const context = {} as ExecutionContext;
  const handlerThrowing = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) });

  const intercepted = (error: unknown): Promise<unknown> =>
    lastValueFrom(interceptor.intercept(context, handlerThrowing(error)));

  it('renders a deadlock as a typed, retryable 409 instead of a bare 500', async () => {
    const victim = deadlock();
    const failure = await intercepted(victim).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransactionDeadlockError);
    expect((failure as TransactionDeadlockError).getStatus()).toBe(Http.Conflict);
    expect((failure as TransactionDeadlockError).getResponse()).toMatchObject({
      statusCode: Http.Conflict,
      code: 'TransactionDeadlockError',
      retryable: true,
    });
  });

  it('keeps the driver error as the cause, so the log still says which cycle it was', async () => {
    const victim = deadlock();
    const failure = (await intercepted(victim).catch((error: unknown) => error)) as Error;

    expect(failure.cause).toBe(victim);
  });

  it('renders the raw-statement shape too, not only the model-write one', async () => {
    const failure = await intercepted(deadlock({ wrapped: true })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransactionDeadlockError);
  });

  it('passes every other failure through untouched', async () => {
    const violation = uniqueViolation();

    await expect(intercepted(violation)).rejects.toBe(violation);
  });

  it('leaves a successful response alone', async () => {
    await expect(lastValueFrom(interceptor.intercept(context, { handle: () => of('ok') }))).resolves.toBe('ok');
  });
});
