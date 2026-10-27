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
import { EVENT_STATUS_DATE_SELECT } from '../utils/event-status.util';
import { EventLifecycleService } from './event-lifecycle.service';
import {
  EventArchivedEvent,
  EventCancelledEvent,
  EventReopenedEvent,
  EventUnarchivedEvent,
} from './events/event-lifecycle.events';

const COND = { id: 'sentinel-condition' };
const EVENT_ID = 'event-1';
const ARCHIVED_AT = new Date('2026-06-02T12:00:00.000Z');

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
    tx.eventOccurrence.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  /** The emits, by name. */
  const emitted = (name: string) => emitter.emit.mock.calls.filter(([emittedName]) => emittedName === name);

  describe.each([
    ['cancelEvent', () => service.cancelEvent(EVENT_ID, {})],
    ['reopenEvent', () => service.reopenEvent(EVENT_ID)],
  ])('%s', (name, run) => {
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
      row = name === 'cancelEvent' ? live() : cancelled();
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

    // The status is worked out from dates read under the lock, so nothing
    // is read after the commit, where a failed read would report a
    // transition that happened as one that didn't.
    it('answers with the status its dates give, read under the lock and not after the commit (#795)', async () => {
      row = name === 'cancelEvent' ? live() : cancelled();
      tx.eventOccurrence.findMany.mockResolvedValue([
        { status: OccurrenceStatus.Confirmed, startDate: new Date(Date.now() + 60 * 60 * 1000), endDate: null },
      ] as never);

      await expect(run()).resolves.toEqual(
        expect.objectContaining({
          status: name === 'cancelEvent' ? EventStatus.Cancelled : EventStatus.Scheduled,
        }),
      );
      expect(tx.eventOccurrence.findMany).toHaveBeenCalledWith({
        where: { eventId: EVENT_ID },
        select: EVENT_STATUS_DATE_SELECT,
      });
      expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
    });

    it('answers 403 when the write finds the row outside the actor’s grant (#795)', async () => {
      row = name === 'cancelEvent' ? live() : cancelled();
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

    // Archived since, it is still where the cancel asks it to go: cancelled.
    // An archived event is put away: unarchive it first.
    it('answers 400 for an archived event that is not cancelled: unarchive it first (#795)', async () => {
      row = { ...live(), archivedAt: ARCHIVED_AT };

      const rejection: unknown = await service.cancelEvent(EVENT_ID, {}).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(BadRequestException);
      expect((rejection as BadRequestException).getResponse()).toEqual(t('errors.event.archived'));
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers a repeat on a cancelled event archived since with the event as it is (#795)', async () => {
      row = cancelled({ archivedAt: ARCHIVED_AT });

      await expect(service.cancelEvent(EVENT_ID, { reason: 'second reason' })).resolves.toEqual(
        expect.objectContaining({ cancelReason: 'first reason', status: EventStatus.Archived }),
      );
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(tx.eventOccurrence.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses a repeat from someone whose grant does not reach the event (#795)', async () => {
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

    it('refuses that repeat from someone whose grant does not reach the event (#795)', async () => {
      row = live();
      tx.event.count.mockResolvedValue(0);

      await expect(service.reopenEvent(EVENT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    });

    // The reopen already happened, and the event, over by now, was archived
    // since: a retry answers as a cancel's does on an event cancelled and
    // archived since.
    it('answers a repeat on an event archived since the reopen with the event as it is (#795)', async () => {
      row = { ...live(), archivedAt: ARCHIVED_AT };

      await expect(service.reopenEvent(EVENT_ID)).resolves.toEqual(
        expect.objectContaining({ id: EVENT_ID, status: EventStatus.Archived }),
      );
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers 400 for a cancelled event that is archived: unarchive it first (#795)', async () => {
      row = cancelled({ archivedAt: ARCHIVED_AT });

      const rejection: unknown = await service.reopenEvent(EVENT_ID).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(BadRequestException);
      expect((rejection as BadRequestException).getResponse()).toEqual(t('errors.event.archived'));
      expect(tx.event.update).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['archiveEvent', () => service.archiveEvent(EVENT_ID)],
    ['unarchiveEvent', () => service.unarchiveEvent(EVENT_ID)],
  ])('%s', (name, run) => {
    /** A row the transition changes: a cancelled event, archived for an unarchive. */
    const changeable = () =>
      name === 'archiveEvent' ? cancelled() : cancelled({ archivedAt: new Date('2026-06-02T12:00:00.000Z') });

    it('locks the event row before it reads the event (#795)', async () => {
      row = changeable();
      await run();

      const [[lock]] = tx.$queryRaw.mock.calls;
      expect(rawQueryText(lock)).toMatch(/^SELECT id FROM events WHERE id = \? FOR NO KEY UPDATE$/);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.event.findUnique.mock.invocationCallOrder[0]);
    });

    it('binds its write to the archive grants (#795)', async () => {
      row = changeable();
      await run();

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.Event,
        Action.update,
        'archivedAt',
      );
    });

    it('answers 404 for a deleted event (#795)', async () => {
      row = { ...changeable(), deletedAt: new Date() };

      await expect(run()).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.event.update).not.toHaveBeenCalled();
    });

    it('answers 403 when the write finds the row outside the actor’s grant (#795)', async () => {
      row = changeable();
      tx.event.update.mockRejectedValue(dependentRecordNotFound());

      await expect(run()).rejects.toBeInstanceOf(ForbiddenException);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // Put away and taken out again by its host, audited, and nobody told:
    // no notification and no webhook.
    it('sends its domain event alone (#795)', async () => {
      row = changeable();
      await run();

      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const [[emittedName, domainEvent]] = emitter.emit.mock.calls;
      expect(emittedName).toBe(name === 'archiveEvent' ? EventEvents.EventArchived : EventEvents.EventUnarchived);
      expect(domainEvent).toBeInstanceOf(name === 'archiveEvent' ? EventArchivedEvent : EventUnarchivedEvent);
      expect(domainEvent.subjectId).toBe(EVENT_ID);
      expect(Object.keys(domainEvent.before).sort()).toEqual(['archivedAt', 'householdId', 'id']);
    });
  });

  describe('archiveEvent', () => {
    const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000);
    const confirmed = (startDate: Date, endDate: Date | null = null) => ({
      status: OccurrenceStatus.Confirmed,
      startDate,
      endDate,
    });

    it('archives a cancelled event, requiring the state it read (#795)', async () => {
      row = cancelled();

      await expect(service.archiveEvent(EVENT_ID)).resolves.toEqual(
        expect.objectContaining({ id: EVENT_ID, archivedAt: expect.any(Date), status: EventStatus.Archived }),
      );
      expect(tx.event.update).toHaveBeenCalledWith({
        where: { id: EVENT_ID, archivedAt: null, AND: [COND] },
        data: { archivedAt: expect.any(Date) },
      });
    });

    // Its dates are read under the event's lock, which a date write also
    // takes, so the status judged is the one the write meets.
    it('archives an event whose dates have all passed, reading them under the lock (#795)', async () => {
      tx.eventOccurrence.findMany.mockResolvedValue([confirmed(hoursFromNow(-30), hoursFromNow(-24))] as never);

      await service.archiveEvent(EVENT_ID);

      expect(tx.eventOccurrence.findMany).toHaveBeenCalledWith({
        where: { eventId: EVENT_ID },
        select: EVENT_STATUS_DATE_SELECT,
      });
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.eventOccurrence.findMany.mock.invocationCallOrder[0],
      );
      expect(tx.event.update).toHaveBeenCalled();
    });

    // A live event is cancelled first, then archived.
    it.each<[string, () => unknown[]]>([
      ['Planning, with no dates', () => []],
      ['Scheduled', () => [confirmed(hoursFromNow(24))]],
      ['Ongoing', () => [confirmed(hoursFromNow(-1), hoursFromNow(1))]],
    ])('refuses an event that is %s with 400 (#795)', async (_, dates) => {
      tx.eventOccurrence.findMany.mockResolvedValue(dates() as never);

      const rejection: unknown = await service.archiveEvent(EVENT_ID).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(BadRequestException);
      expect((rejection as BadRequestException).getResponse()).toEqual(t('errors.event.not_archivable'));
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers a repeat with the event as it is, writing and sending nothing (#795)', async () => {
      row = cancelled({ archivedAt: new Date('2026-06-02T12:00:00.000Z') });

      await expect(service.archiveEvent(EVENT_ID)).resolves.toEqual(
        expect.objectContaining({ status: EventStatus.Archived }),
      );
      expect(tx.event.count).toHaveBeenCalledWith({ where: { id: EVENT_ID, AND: [COND] } });
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses a repeat from someone whose grant does not reach the event (#795)', async () => {
      row = cancelled({ archivedAt: ARCHIVED_AT });
      tx.event.count.mockResolvedValue(0);

      await expect(service.archiveEvent(EVENT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('unarchiveEvent', () => {
    it('clears archivedAt, requiring the state it read (#795)', async () => {
      row = cancelled({ archivedAt: new Date('2026-06-02T12:00:00.000Z') });

      await service.unarchiveEvent(EVENT_ID);

      expect(tx.event.update).toHaveBeenCalledWith({
        where: { id: EVENT_ID, archivedAt: { not: null }, AND: [COND] },
        data: { archivedAt: null },
      });
    });

    it('returns a cancelled event to Cancelled (#795)', async () => {
      row = cancelled({ archivedAt: new Date('2026-06-02T12:00:00.000Z') });

      await expect(service.unarchiveEvent(EVENT_ID)).resolves.toEqual(
        expect.objectContaining({ archivedAt: null, status: EventStatus.Cancelled }),
      );
    });

    it('answers an unarchive of an event not archived with the event as it is, sending nothing (#795)', async () => {
      row = cancelled();

      await expect(service.unarchiveEvent(EVENT_ID)).resolves.toEqual(
        expect.objectContaining({ status: EventStatus.Cancelled }),
      );
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  // The grant is checked before the event's state is judged, so a 400 never
  // tells someone the grant doesn't reach whether the event is cancelled,
  // archived or over.
  describe.each([
    ['cancelEvent', () => service.cancelEvent(EVENT_ID, {}), () => ({ ...live(), archivedAt: ARCHIVED_AT })],
    ['reopenEvent', () => service.reopenEvent(EVENT_ID), () => cancelled({ archivedAt: ARCHIVED_AT })],
    ['archiveEvent', () => service.archiveEvent(EVENT_ID), () => live()],
    ['unarchiveEvent', () => service.unarchiveEvent(EVENT_ID), () => cancelled({ archivedAt: ARCHIVED_AT })],
  ])('%s by someone whose grant does not reach the event', (_, run, found) => {
    it("answers 403 before judging the event's state, writing and sending nothing (#795)", async () => {
      row = found();
      tx.event.count.mockResolvedValue(0);

      const rejection: unknown = await run().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.update'));
      expect(tx.event.count).toHaveBeenCalledWith({ where: { id: EVENT_ID, AND: [COND] } });
      expect(tx.eventOccurrence.findMany).not.toHaveBeenCalled();
      expect(tx.event.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
