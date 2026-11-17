import { liveEventWhere, type DatabaseService } from '@bge/database';
import { t } from '@bge/i18n';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { assertEventExists, isEventLive, requireEvent } from './event-access.helpers';

describe('event access helpers (#992)', () => {
  let db: MockDatabaseService;

  beforeEach(() => {
    db = createMockDatabaseService();
  });

  // A household delete stamps only the household, so the event's own
  // `deletedAt` stays null; only the shared clause says the event is gone.
  it('asks whether an event is live through the shared liveness clause', async () => {
    db.event.count.mockResolvedValue(1);

    await expect(isEventLive(db as unknown as DatabaseService, 'event-1')).resolves.toBe(true);
    expect(db.event.count).toHaveBeenCalledWith({ where: { id: 'event-1', ...liveEventWhere() } });
  });

  it("answers the event's 404 for an event that isn't live", async () => {
    db.event.count.mockResolvedValue(0);

    await expect(assertEventExists(db as unknown as DatabaseService, 'event-1')).rejects.toThrow(
      new NotFoundException(t('errors.event.not_found', { id: 'event-1' })),
    );
    expect(db.event.count).toHaveBeenCalledWith({ where: { id: 'event-1', ...liveEventWhere() } });
  });

  it("reads a create's parent event through the shared liveness clause", async () => {
    db.event.findUnique.mockResolvedValue(null);

    await expect(requireEvent(db as unknown as DatabaseService, 'event-1')).rejects.toThrow(NotFoundException);
    expect(db.event.findUnique).toHaveBeenCalledWith({
      where: { id: 'event-1', ...liveEventWhere() },
      select: { id: true, householdId: true },
    });
  });
});
