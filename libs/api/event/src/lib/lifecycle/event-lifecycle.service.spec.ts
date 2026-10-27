import { Action, EventStatus, OccurrenceStatus, Prisma, ResourceType, type Event } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createMockDatabaseService,
  createTestingModuleWithDb,
  makeEvent,
  MOCK_ACTING_USER_ID,
  rawQueryText,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventEvents } from '../constants/event-events.constant';
import { EventService } from '../event.service';
import { withEventStatus } from '../utils/event-status.util';
import { EventLifecycleService } from './event-lifecycle.service';
import { EventCancelledEvent, EventReopenedEvent } from './events/event-lifecycle.events';

const COND = { id: 'sentinel-condition' };
const EVENT_ID = 'event-1';

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
    code: 'P2025',
    clientVersion: 'test',
  });

describe('EventLifecycleService', () => {
  let service: EventLifecycleService;
  let db: MockDatabaseService;
  /** The transaction's client, apart from `db`, so a write outside the transaction can't pass for one inside it. */
  let tx: MockDatabaseService;
  let abilityService: MockAbilityService;
  let emitter: { emit: jest.Mock };

  /** The row the lock-then-read finds. */
  let row: Event | null;

  const live = () => makeEvent({ id: EVENT_ID, title: 'Game night', householdId: 'hh-1' });
  const cancelled = (overrides: Partial<Event> = {}) =>
    makeEvent({
      id: EVENT_ID,
      title: 'Game night',
      householdId: 'hh-1',
      cancelledAt: new Date('2026-06-01T12:00:00.000Z'),
      cancelledById: 'user-9',
      cancelReason: 'first reason',
      ...overrides,
    });

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventLifecycleService,
        { provide: EventEmitter2, useValue: emitter },
        { provide: AbilityService, useValue: abilityService },
        // The status as the real rule gives it, from no dates: the event's own
        // decisions decide it in every case here.
        {
          provide: EventService,
          useValue: { statusOf: jest.fn((event: Event) => withEventStatus(event, [], new Date())) },
        },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventLifecycleService);

    tx = createMockDatabaseService();
    db.$transaction.mockImplementation((async (callback: (client: MockDatabaseService) => Promise<unknown>) => {
      const result = await callback(tx);

      // Nothing is told of a change before it commits.
      expect(emitter.emit).not.toHaveBeenCalled();

      return result;
    }) as never);

    row = live();
    tx.$queryRaw.mockResolvedValue([]);
    tx.event.findUnique.mockImplementation((() => Promise.resolve(row)) as never);
    tx.event.update.mockImplementation(((args: { data: Partial<Event> }) =>
      Promise.resolve({ ...row, ...args.data })) as never);
    tx.event.count.mockResolvedValue(1);
    tx.eventOccurrence.updateMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => jest.clearAllMocks());

  /** The emits, by name. */
  const emitted = (name: string) => emitter.emit.mock.calls.filter(([emittedName]) => emittedName === name);

  describe.each([
    ['cancelEvent', () => service.cancelEvent(EVENT_ID, {})],
    ['reopenEvent', () => service.reopenEvent(EVENT_ID)],
  ])('%s', (_, run) => {
    // The cancel cascade and a date write each take this lock, so they take
    // turns, and the read below sees whichever committed first.
    it('locks the event row before it reads the event (#795)', async () => {
      row = cancelled();
      await run().catch(() => undefined);

      const [[lock]] = tx.$queryRaw.mock.calls;
      expect(rawQueryText(lock)).toMatch(/^SELECT id FROM events WHERE id = \? FOR NO KEY UPDATE$/);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.event.findUnique.mock.invocationCallOrder[0]);
    });

    it('binds its write to the cancel column grants (#795)', async () => {
      row = _ === 'cancelEvent' ? live() : cancelled();
      await run();

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.Event,
        Action.update,
        'cancelledAt',
      );
    });

    it.each<[string, () => Event | null]>([
      ['a missing event', () => null],
      ['a deleted event', () => cancelled({ deletedAt: new Date() })],
    ])('answers 404 for %s (#795)', async (__, found) => {
      row = found();

      const rejection: unknown = await run().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(NotFoundException);
      expect((rejection as NotFoundException).getResponse()).toEqual(t('errors.event.not_found', { id: EVENT_ID }));
      expect(tx.event.update).not.toHaveBeenCalled();
    });

    // An archived event is put away: undo that first. Cancelled or not, it
    // answers the same.
    it.each([
      ['an archived event', () => live()],
      ['an archived, cancelled event', () => cancelled()],
    ])('answers 400 for %s: unarchive it first (#795)', async (__, base) => {
      row = { ...base(), archivedAt: new Date('2026-06-02T12:00:00.000Z') };

      const rejection: unknown = await run().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(BadRequestException);
      expect((rejection as BadRequestException).getResponse()).toEqual(t('errors.event.archived'));
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers 403 when the write finds the row outside the caller’s grant (#795)', async () => {
      row = _ === 'cancelEvent' ? live() : cancelled();
      tx.event.update.mockRejectedValue(dependentRecordNotFound());

      const rejection: unknown = await run().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.update'));
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('cancelEvent', () => {
    it('cancels the event, its confirmed dates and its proposed ones in one transaction (#795)', async () => {
      await service.cancelEvent(EVENT_ID, { reason: 'rain' });

      const [[{ data: written }]] = tx.event.update.mock.calls as unknown as [[{ data: { cancelledAt: Date } }]];
      const cancelledAt = written.cancelledAt;

      expect(cancelledAt).toBeInstanceOf(Date);
      expect(tx.event.update).toHaveBeenCalledWith({
        where: { id: EVENT_ID, cancelledAt: null, AND: [COND] },
        data: { cancelledAt, cancelledById: MOCK_ACTING_USER_ID, cancelReason: 'rain' },
      });
      expect(tx.eventOccurrence.updateMany).toHaveBeenCalledWith({
        where: { eventId: EVENT_ID, status: OccurrenceStatus.Confirmed },
        data: {
          status: OccurrenceStatus.Cancelled,
          cancelledAt,
          cancelledById: MOCK_ACTING_USER_ID,
          cancelReason: 'rain',
        },
      });
      expect(tx.eventOccurrence.updateMany).toHaveBeenCalledWith({
        where: { eventId: EVENT_ID, status: OccurrenceStatus.Proposed },
        data: { status: OccurrenceStatus.Declined, declinedAt: cancelledAt },
      });
      expect(db.event.update).not.toHaveBeenCalled();
      expect(db.eventOccurrence.updateMany).not.toHaveBeenCalled();
    });

    it('writes no reason when none is given (#795)', async () => {
      await service.cancelEvent(EVENT_ID, {});

      expect(tx.event.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ cancelReason: null }) }),
      );
      expect(tx.eventOccurrence.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ cancelReason: null }) }),
      );
    });

    it('sends one EventCancelled domain event and one webhook, and nothing per date (#795)', async () => {
      await service.cancelEvent(EVENT_ID, { reason: 'rain' });

      expect(emitter.emit).toHaveBeenCalledTimes(2);

      const [[, domainEvent]] = emitted(EventEvents.EventCancelled);
      expect(domainEvent).toBeInstanceOf(EventCancelledEvent);
      expect(domainEvent.subjectId).toBe(EVENT_ID);
      expect(domainEvent.actingUserId).toBe(MOCK_ACTING_USER_ID);
      expect(domainEvent.before).toEqual({
        id: EVENT_ID,
        title: 'Game night',
        householdId: 'hh-1',
        cancelledAt: null,
        cancelledById: null,
        cancelReason: null,
      });
      expect(domainEvent.after).toEqual({
        id: EVENT_ID,
        title: 'Game night',
        householdId: 'hh-1',
        cancelledAt: expect.any(Date),
        cancelledById: MOCK_ACTING_USER_ID,
        cancelReason: 'rain',
      });

      // Keyed on the cancel's time, so a later cancel after a reopen is a
      // delivery of its own. Ids only, as every Event webhook carries.
      expect(emitter.emit).toHaveBeenCalledWith(WebhookEventType.EventCancelled, {
        subjectId: EVENT_ID,
        householdId: 'hh-1',
        occurrenceId: `${EVENT_ID}:cancelled:${domainEvent.after.cancelledAt.getTime()}`,
        data: { eventId: EVENT_ID, householdId: 'hh-1' },
      });
    });

    it('answers with the event, its status Cancelled (#795)', async () => {
      await expect(service.cancelEvent(EVENT_ID, { reason: 'rain' })).resolves.toEqual(
        expect.objectContaining({ id: EVENT_ID, cancelReason: 'rain', status: EventStatus.Cancelled }),
      );
    });

    // A retry finds the event where it asked to go: the first reason stands,
    // and nobody is told twice.
    it('answers a repeat with the event as it is, writing and sending nothing (#795)', async () => {
      row = cancelled();

      await expect(service.cancelEvent(EVENT_ID, { reason: 'second reason' })).resolves.toEqual(
        expect.objectContaining({ cancelReason: 'first reason', status: EventStatus.Cancelled }),
      );
      expect(tx.event.count).toHaveBeenCalledWith({ where: { id: EVENT_ID, AND: [COND] } });
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(tx.eventOccurrence.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses a repeat from a caller whose grant does not reach the event (#795)', async () => {
      row = cancelled();
      tx.event.count.mockResolvedValue(0);

      const rejection: unknown = await service.cancelEvent(EVENT_ID, {}).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.update'));
    });
  });

  describe('reopenEvent', () => {
    beforeEach(() => {
      row = cancelled();
    });

    it('clears the cancel, requiring the state it read, and leaves the dates as cancel left them (#795)', async () => {
      await service.reopenEvent(EVENT_ID);

      expect(tx.event.update).toHaveBeenCalledWith({
        where: { id: EVENT_ID, cancelledAt: { not: null }, archivedAt: null, AND: [COND] },
        data: { cancelledAt: null, cancelledById: null, cancelReason: null },
      });
      expect(tx.eventOccurrence.updateMany).not.toHaveBeenCalled();
    });

    it('sends one EventReopened domain event and one webhook (#795)', async () => {
      await service.reopenEvent(EVENT_ID);

      expect(emitter.emit).toHaveBeenCalledTimes(2);

      const [[, domainEvent]] = emitted(EventEvents.EventReopened);
      expect(domainEvent).toBeInstanceOf(EventReopenedEvent);
      expect(domainEvent.actingUserId).toBe(MOCK_ACTING_USER_ID);
      expect(domainEvent.before).toEqual(
        expect.objectContaining({ id: EVENT_ID, title: 'Game night', cancelReason: 'first reason' }),
      );
      expect(domainEvent.after).toEqual(
        expect.objectContaining({ cancelledAt: null, cancelledById: null, cancelReason: null }),
      );

      expect(emitter.emit).toHaveBeenCalledWith(WebhookEventType.EventReopened, {
        subjectId: EVENT_ID,
        householdId: 'hh-1',
        occurrenceId: `${EVENT_ID}:reopened:${domainEvent.initiatedAt.getTime()}`,
        data: { eventId: EVENT_ID, householdId: 'hh-1' },
      });
    });

    it('answers with the event, its status from its dates again (#795)', async () => {
      await expect(service.reopenEvent(EVENT_ID)).resolves.toEqual(
        expect.objectContaining({ id: EVENT_ID, cancelledAt: null, status: EventStatus.Planning }),
      );
    });

    it('answers a reopen of an event not cancelled with the event as it is, sending nothing (#795)', async () => {
      row = live();

      await expect(service.reopenEvent(EVENT_ID)).resolves.toEqual(
        expect.objectContaining({ id: EVENT_ID, status: EventStatus.Planning }),
      );
      expect(tx.event.count).toHaveBeenCalledWith({ where: { id: EVENT_ID, AND: [COND] } });
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses that repeat from a caller whose grant does not reach the event (#795)', async () => {
      row = live();
      tx.event.count.mockResolvedValue(0);

      await expect(service.reopenEvent(EVENT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
