import { DatabaseService, ResourceType } from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { createPrismaAbility } from '@casl/prisma';
import { WEBHOOK_EVENT_DESCRIPTORS } from '../constants/webhook-event-types';
import { WebhookVisibilityService } from './webhook-visibility.service';

describe('WebhookVisibilityService', () => {
  let service: WebhookVisibilityService;
  let db: MockDatabaseService;

  // Deny-all ability is sufficient: these tests assert the query *shape* the
  // service builds around the CASL clause, not what the clause itself resolves.
  const ability = createPrismaAbility([]) as AppAbility;

  beforeEach(() => {
    db = createMockDatabaseService();
    service = new WebhookVisibilityService(db as unknown as DatabaseService);
  });

  afterEach(() => jest.clearAllMocks());

  it('reports an Event visible when a matching non-deleted row exists', async () => {
    db.event.count.mockResolvedValue(1);

    await expect(service.isVisibleTo(ResourceType.Event, 'event-1', ability)).resolves.toBe(true);
    expect(db.event.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'event-1', deletedAt: null, AND: [expect.anything()] }),
    });
  });

  it('reports an Event not visible when no matching row exists', async () => {
    db.event.count.mockResolvedValue(0);

    await expect(service.isVisibleTo(ResourceType.Event, 'event-1', ability)).resolves.toBe(false);
  });

  it('filters soft-deleted rows for the Game subject too', async () => {
    db.game.count.mockResolvedValue(2);

    await expect(service.isVisibleTo(ResourceType.Game, 'game-1', ability)).resolves.toBe(true);
    expect(db.game.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'game-1', deletedAt: null }),
    });
  });

  it('does NOT apply a deletedAt guard for the Job subject (no soft-delete column)', async () => {
    db.job.count.mockResolvedValue(1);

    await expect(service.isVisibleTo(ResourceType.Job, 'job-1', ability)).resolves.toBe(true);

    const where = db.job.count.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where).toMatchObject({ id: 'job-1', AND: [expect.anything()] });
    expect('deletedAt' in where).toBe(false);
  });

  it('filters soft-deleted rows for the Household subject (#158)', async () => {
    db.household.count.mockResolvedValue(1);

    await expect(service.isVisibleTo(ResourceType.Household, 'hh-1', ability)).resolves.toBe(true);
    expect(db.household.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'hh-1', deletedAt: null, AND: [expect.anything()] }),
    });
  });

  it('fails loudly for an unmapped subject', async () => {
    // Previously used Household, which #158 mapped. Any subject with a
    // registered descriptor MUST have a check here or dispatch throws, so the
    // example has to be a subject no descriptor names.
    await expect(service.isVisibleTo(ResourceType.Invite, 'invite-1', ability)).rejects.toThrow(
      /No webhook visibility check implemented for subject "Invite"/,
    );
    expect(db.invite.count).not.toHaveBeenCalled();
  });

  it('implements a check for every subject a registered descriptor names', async () => {
    // The guard that would have caught #158's original plan: registering a
    // descriptor without a visibility check produces an event that is accepted
    // at subscription time and then never delivered, visible only as an ERROR
    // log per subscriber. Unmocked counts resolve `undefined`, so every mapped
    // subject reports "not visible" rather than throwing.
    const subjects = [...new Set(Object.values(WEBHOOK_EVENT_DESCRIPTORS).map((descriptor) => descriptor.subject))];

    for (const subject of subjects) {
      await expect(service.isVisibleTo(subject, 'any-id', ability)).resolves.toBe(false);
    }
  });
});
