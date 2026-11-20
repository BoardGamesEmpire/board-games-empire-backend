import type { Prisma } from '@bge/database';
import { liveEventWhere } from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService, makeEvent, rawQueryText } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { lockLiveEvent, lockLiveEventDates, shareLiveEvent } from './lock-live-event.util';

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

describe('shareLiveEvent', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
    tx.$queryRaw.mockResolvedValue([]);
  });

  const share = () => shareLiveEvent(tx as unknown as Prisma.TransactionClient, 'event-1');

  // FOR SHARE conflicts with the UPDATE a delete runs, so a write that took
  // it first holds the delete off until it commits, and one that queued
  // behind the delete reads it deleted. FOR KEY SHARE would let the delete
  // through.
  it('takes the event row FOR SHARE before checking it (#1065)', async () => {
    tx.event.count.mockResolvedValue(1);

    await expect(share()).resolves.toBeUndefined();
    expect(rawQueryText(tx.$queryRaw.mock.calls[0][0])).toMatch(/^SELECT id FROM events WHERE id = \? FOR SHARE$/);
    expect(tx.event.count).toHaveBeenCalledWith({ where: { id: 'event-1', ...liveEventWhere() } });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.event.count.mock.invocationCallOrder[0]);
  });

  it('answers 404 for a deleted event or one whose household is deleted (#1065)', async () => {
    tx.event.count.mockResolvedValue(0);

    await expect(share()).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('lockLiveEventDates', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
    tx.$queryRaw.mockResolvedValue([]);
  });

  const lock = () => lockLiveEventDates(tx as unknown as Prisma.TransactionClient, 'event-1');

  // The lock a write to the event's dates takes, and the same check
  // shareLiveEvent runs, read under it (#1065).
  it('takes the event row FOR NO KEY UPDATE before checking it (#1065)', async () => {
    tx.event.count.mockResolvedValue(1);

    await expect(lock()).resolves.toBeUndefined();
    expect(rawQueryText(tx.$queryRaw.mock.calls[0][0])).toMatch(
      /^SELECT id FROM events WHERE id = \? FOR NO KEY UPDATE$/,
    );
    expect(tx.event.count).toHaveBeenCalledWith({ where: { id: 'event-1', ...liveEventWhere() } });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.event.count.mock.invocationCallOrder[0]);
  });

  it('answers 404 for a deleted event or one whose household is deleted (#1065)', async () => {
    tx.event.count.mockResolvedValue(0);

    await expect(lock()).rejects.toBeInstanceOf(NotFoundException);
  });
});
