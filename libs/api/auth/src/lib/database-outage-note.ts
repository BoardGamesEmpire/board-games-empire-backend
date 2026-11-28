import { isDatabaseUnavailableError } from '@bge/database';
import type { BetterAuthOptions } from 'better-auth';
import type { DBAdapter } from 'better-auth/types';
import { noteDatabaseUnavailable } from './storage-failure-record';

/**
 * Runs `run`, noting on the request's record a database outage it fails with,
 * then rethrowing it. better-auth's email sign-up catches a failed user create,
 * its hooks included, and answers its own 422 without the error, so the note
 * is what lets `createAuthRequestHandler` answer the outage 503 (#1172).
 */
export async function notingDatabaseOutage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      noteDatabaseUnavailable();
    }

    throw error;
  }
}

/**
 * better-auth's database adapter, with every call noting the outage it fails
 * with (#1172). Its other fields pass through as they are.
 */
export function notingAdapterOutages<Options extends BetterAuthOptions>(
  factory: (options: Options) => DBAdapter<Options>,
): (options: Options) => DBAdapter<Options> {
  return (options) => noting(factory(options));
}

/**
 * `adapter` with its methods noting outages. A transaction's callback gets
 * the adapter it runs on noted too: better-auth runs a sign-up's writes on
 * that one, not on the adapter it was given.
 */
function noting<A extends object>(adapter: A): A {
  return new Proxy(adapter, {
    get(target, name) {
      const value: unknown = Reflect.get(target, name);
      if (typeof value !== 'function') {
        return value;
      }

      if (name === 'transaction') {
        return (callback: (trx: object) => Promise<unknown>) =>
          notingDatabaseOutage(async () => value.call(target, (trx: object) => callback(noting(trx))));
      }

      return (...args: unknown[]) => notingDatabaseOutage(async () => value.apply(target, args));
    },
  });
}
