import type { StorageFailureRecord } from './storage-failure-record';
import { noteDatabaseUnavailable, noteStorageFailure, withStorageFailureRecord } from './storage-failure-record';

/**
 * A request's record of whether a storage call failed, so the handler on
 * `/api/auth/*` can tell a storage failure from a fault even where better-auth
 * answers its own 500 and drops the error (#894).
 */
describe('storage failure record', () => {
  it('notes a failure in the scope it happens in, across awaits (#894)', async () => {
    const record: StorageFailureRecord = { databaseUnavailable: false, failed: false };

    await withStorageFailureRecord(record, async () => {
      await Promise.resolve();
      noteStorageFailure();
    });

    expect(record.failed).toBe(true);
  });

  it('keeps two concurrent scopes apart (#894)', async () => {
    const failing: StorageFailureRecord = { databaseUnavailable: false, failed: false };
    const succeeding: StorageFailureRecord = { databaseUnavailable: false, failed: false };

    await Promise.all([
      withStorageFailureRecord(failing, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        noteStorageFailure();
      }),
      withStorageFailureRecord(succeeding, async () => {
        await new Promise((resolve) => setImmediate(resolve));
      }),
    ]);

    expect(failing.failed).toBe(true);
    expect(succeeding.failed).toBe(false);
  });

  it('notes nothing outside a scope (#894)', () => {
    expect(() => noteStorageFailure()).not.toThrow();
  });

  it('notes a database outage apart from a storage failure (#1172)', async () => {
    const record: StorageFailureRecord = { databaseUnavailable: false, failed: false };

    await withStorageFailureRecord(record, async () => {
      await Promise.resolve();
      noteDatabaseUnavailable();
    });

    expect(record).toEqual({ databaseUnavailable: true, failed: false });
  });

  it('notes no database outage outside a scope (#1172)', () => {
    expect(() => noteDatabaseUnavailable()).not.toThrow();
  });
});
