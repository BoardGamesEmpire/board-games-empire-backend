import type { Response, Test } from 'supertest';

/**
 * A request used like a supertest `Test` whose body needs an async read first:
 * an install or approval names the risks its read showed (#1336). `.set()`
 * and `.expect()` are recorded and applied, in order, once `build` has made
 * the request from what `read` returned, and awaiting it sends it.
 *
 * `build` is synchronous on purpose: an async function cannot hand back a
 * `Test` unsent, because resolving a promise with a thenable sends it.
 */
export interface DeferredTest extends PromiseLike<Response> {
  expect(status: number): DeferredTest;
  set(field: string, value: string): DeferredTest;
}

export function deferredRequest<T>(read: () => Promise<T>, build: (value: T) => Test): DeferredTest {
  const steps: ((test: Test) => Test)[] = [];

  const deferred: DeferredTest = {
    set(field, value) {
      steps.push((test) => test.set(field, value));

      return deferred;
    },
    expect(status) {
      steps.push((test) => test.expect(status));

      return deferred;
    },
    then(onFulfilled, onRejected) {
      return read()
        .then((value) => steps.reduce((test, step) => step(test), build(value)))
        .then(onFulfilled, onRejected);
    },
  };

  return deferred;
}
