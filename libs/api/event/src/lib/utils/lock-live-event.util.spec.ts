import { liveEventWhere, type Prisma } from '@bge/database';
import { createMockDatabaseService, makeEvent, rawQueryText, type MockDatabaseService } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { lockLiveEvent } from './lock-live-event.util';

describe('lockLiveEvent', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
    tx.$queryRaw.mockResolvedValue([]);
  });

  const lock = () => lockLiveEvent(tx as unknown as Prisma.TransactionClient, 'event-1');

  // A household delete stamps only the household, so a write that queued
  // behind it reads the event's own row live; the shared clause, read under
  // the lock, says it is gone.
  it('reads the row again under the lock through the shared liveness clause (#992)', async () => {
    const event = makeEvent({ id: 'event-1' });
    tx.event.findUnique.mockResolvedValue(event);

    await expect(lock()).resolves.toBe(event);
    expect(rawQueryText(tx.$queryRaw.mock.calls[0][0])).toMatch(/FOR NO KEY UPDATE$/);
    expect(tx.event.findUnique).toHaveBeenCalledWith({ where: { id: 'event-1', ...liveEventWhere() } });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.event.findUnique.mock.invocationCallOrder[0]);
  });

  it("answers the event's 404 when the clause finds no live row (#992)", async () => {
    tx.event.findUnique.mockResolvedValue(null);

    await expect(lock()).rejects.toBeInstanceOf(NotFoundException);
  });
});
