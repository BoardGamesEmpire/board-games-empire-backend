import { databaseUnreachable } from '@bge/database/testing';
import type { BetterAuthOptions } from 'better-auth';
import type { DBAdapter } from 'better-auth/types';
import { notingAdapterOutages } from './database-outage-note';
import type { StorageFailureRecord } from './storage-failure-record';
import { withStorageFailureRecord } from './storage-failure-record';

/**
 * better-auth's email sign-up swallows a failed user create into a 422 of its
 * own, so the adapter notes an outage on the request's record (#1172).
 */
describe('notingAdapterOutages (#1172)', () => {
  const fresh = (): StorageFailureRecord => ({ databaseUnavailable: false, failed: false });

  function adapterWith(create: () => Promise<unknown>, trx?: object) {
    const inner = {
      id: 'prisma',
      create,
      transaction: async (callback: (trx: object) => Promise<unknown>) => callback(trx ?? inner),
    };

    return notingAdapterOutages(() => inner as unknown as DBAdapter)({} as BetterAuthOptions);
  }

  it('notes an outage a call fails with, and rethrows it', async () => {
    const outage = databaseUnreachable();
    const adapter = adapterWith(async () => {
      throw outage;
    });
    const record = fresh();

    await expect(withStorageFailureRecord(record, () => adapter.create({ model: 'user', data: {} }))).rejects.toBe(
      outage,
    );
    expect(record.databaseUnavailable).toBe(true);
  });

  it('notes nothing for another failure', async () => {
    const adapter = adapterWith(async () => {
      throw new TypeError('boom');
    });
    const record = fresh();

    await expect(withStorageFailureRecord(record, () => adapter.create({ model: 'user', data: {} }))).rejects.toThrow(
      TypeError,
    );
    expect(record.databaseUnavailable).toBe(false);
  });

  it("notes an outage on the adapter a transaction's callback runs on", async () => {
    const trx = {
      create: async () => {
        throw databaseUnreachable();
      },
    };
    const adapter = adapterWith(async () => ({}), trx);
    const record = fresh();

    await expect(
      withStorageFailureRecord(record, () => adapter.transaction((inner) => inner.create({ model: 'user', data: {} }))),
    ).rejects.toThrow();
    expect(record.databaseUnavailable).toBe(true);
  });

  it("passes a call's result and the adapter's other fields through", async () => {
    const adapter = adapterWith(async () => ({ id: 'u1' }));

    await expect(adapter.create({ model: 'user', data: {} })).resolves.toEqual({ id: 'u1' });
    expect(adapter.id).toBe('prisma');
  });
});
