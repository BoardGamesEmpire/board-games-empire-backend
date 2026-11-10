import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Whether a storage call failed while one request to `/api/auth/*` was being
 * answered (#894). better-auth catches some storage failures itself and
 * answers a 500 of its own without the error, so the error alone can't tell
 * the handler what went wrong. The storage notes its own failures here
 * instead, and `createAuthRequestHandler` reads the note to answer 503.
 */
export interface StorageFailureRecord {
  failed: boolean;
}

/** The record of the request being answered, carried across its awaits. */
const scope = new AsyncLocalStorage<StorageFailureRecord>();

/** Runs `run` as one request, so a storage call inside it notes a failure in `record` (#894). */
export function withStorageFailureRecord<T>(record: StorageFailureRecord, run: () => T): T {
  return scope.run(record, run);
}

/**
 * Notes that a storage call failed, in the record of the request being
 * answered. A call made outside a request, such as `AuthService`'s session
 * read through `auth.api`, has no record and notes nothing, so its own answer
 * is unchanged (#894).
 */
export function noteStorageFailure(): void {
  const record = scope.getStore();
  if (record) {
    record.failed = true;
  }
}
