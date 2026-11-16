import { Action, EventParticipationStatus, Prisma, ResourceType, ScheduledGameRole } from '@bge/database';
import { t } from '@bge/i18n';
import { LineupRemovalReason } from '@bge/notifications-service';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  rawQueryText,
  unwrapTransaction,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { LINEUP_GAME_SNAPSHOT_SELECT, lineupStillAhead } from '../attendee/attendance';
import { ATTENDEE_SUMMARY_SELECT } from '../attendee/attendee-summary';
import { GameRemovedFromEventEvent } from '../nomination/events/nomination.events';
import { ListLineupQueryDto } from './dto/list-lineup.query.dto';
import { LINEUP_GAME_SELECT } from './lineup-game';
import { LineupService } from './lineup.service';

const COND = { id: 'sentinel-condition' };

/** A lineup game as `LINEUP_GAME_SELECT` reads it, supplied by `attendeeId`. */
const lineupRow = (id: string, attendeeId: string) => ({
  id,
  occurrenceId: null,
  platformGameId: `pg-${id}`,
  role: ScheduledGameRole.Primary,
  sortOrder: 0,
  notes: null,
  maxPlayTime: null,
  nominationId: null,
  addedById: attendeeId,
  platformGame: { id: `pg-${id}` },
  suppliedBy: { id: `list-${id}`, attendeeId },
});

/** The same game as `LINEUP_GAME_SNAPSHOT_SELECT` reads it, the event's own. */
const snapshotRow = (id: string, attendeeId: string) => ({
  id,
  eventId: 'event-1',
  occurrenceId: null,
  platformGameId: `pg-${id}`,
  suppliedById: `list-${id}`,
  nominationId: null,
  addedById: attendeeId,
  role: ScheduledGameRole.Primary,
});

/** The attendee read's row, as `ATTENDEE_SUMMARY_SELECT` reads it. */
const attendee = (id: string) => ({
  id,
  status: EventParticipationStatus.Attending,
  guestName: null,
  user: { id: `user-${id}`, username: `name-${id}`, profile: { displayName: null, avatarUrl: null } },
});

describe('LineupService (#799)', () => {
  let service: LineupService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let emitter: { emit: jest.Mock };
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        LineupService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the reads actually run.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: EventEmitter2, useValue: emitter },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(LineupService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');

    unwrapTransaction(db);
    db.event.count.mockResolvedValue(1);
    db.eventOccurrence.findMany.mockResolvedValue([{ id: 'occ-1' }, { id: 'occ-2' }] as never);
    db.eventGame.findMany.mockResolvedValue([]);
    db.eventGame.count.mockResolvedValue(0);
    db.eventAttendee.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  const query = (init: Record<string, unknown> = {}) =>
    plainToInstance(ListLineupQueryDto, { limit: 10, ...init }, { enableImplicitConversion: true });

  it("answers 404 for an event that doesn't exist or was deleted (#799)", async () => {
    db.event.count.mockResolvedValue(0);

    await expect(service.listLineup('missing', query())).rejects.toThrow(NotFoundException);
    expect(db.event.count).toHaveBeenCalledWith({ where: { id: 'missing', deletedAt: null } });
    expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
    expect(db.eventGame.findMany).not.toHaveBeenCalled();
  });

  // A count through any other where, or outside the rows' snapshot, lets
  // `totalPages` promise a page that comes back short (#373).
  it("reads the event's own games and the games of each date the actor can read, under the lineup read ceiling (#799)", async () => {
    db.eventGame.count.mockResolvedValue(7);

    const page = await service.listLineup('event-1', query({ page: 2, limit: 3 }));

    expect(compose).toHaveBeenCalledWith(ResourceType.EventOccurrence, Action.read, { eventId: 'event-1' });
    expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({
      where: { eventId: 'event-1', AND: [COND] },
      select: { id: true },
    });

    const scope = { OR: [{ eventId: 'event-1' }, { occurrenceId: { in: ['occ-1', 'occ-2'] } }] };
    const where = { ...scope, AND: [COND] };
    expect(compose).toHaveBeenCalledWith(ResourceType.EventGame, Action.read, scope);
    expect(db.eventGame.findMany).toHaveBeenCalledWith({
      where,
      select: LINEUP_GAME_SELECT,
      // The dates in their order, then the event's own games, whose date is
      // null and sorts last.
      orderBy: [{ occurrence: { sortOrder: 'asc' } }, { occurrenceId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      skip: 3,
      take: 3,
    });
    expect(db.eventGame.count).toHaveBeenCalledWith({ where });
    const { operations, options } = batchTransactionCall(db);
    expect(operations).toHaveLength(2);
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    expect(page.total).toBe(7);
  });

  // ANDed beside the readable dates rather than put in their place, so naming
  // a date the actor can't read lists nothing. Only that date is read for
  // whether the actor can read it, not every date of the event.
  it('narrows to one date with occurrenceId (#799)', async () => {
    db.eventOccurrence.findMany.mockResolvedValue([{ id: 'occ-1' }] as never);

    await service.listLineup('event-1', query({ occurrenceId: 'occ-1' }));

    expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({
      where: { eventId: 'event-1', id: { in: ['occ-1'] }, AND: [COND] },
      select: { id: true },
    });
    const where = {
      OR: [{ eventId: 'event-1' }, { occurrenceId: { in: ['occ-1'] } }],
      occurrenceId: 'occ-1',
      AND: [COND],
    };
    expect(db.eventGame.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(db.eventGame.count).toHaveBeenCalledWith({ where });
  });

  // The lineup's ceiling names a date's games through the date's event, so it
  // can't keep them from an actor who reads the lineup but no date, such as a
  // key holding read on the lineup alone. The dates read does.
  it("serves the event's own lineup alone to an actor who can read no date (#799)", async () => {
    db.eventOccurrence.findMany.mockResolvedValue([]);

    await service.listLineup('event-1', query());

    const where = { OR: [{ eventId: 'event-1' }, { occurrenceId: { in: [] } }], AND: [COND] };
    expect(db.eventGame.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(db.eventGame.count).toHaveBeenCalledWith({ where });
  });

  // In the game's select, the supplier's name and avatar would reach an actor
  // holding read on the lineup alone (#559): they are read once for the page,
  // under the attendee read ceiling (#799).
  it('names the suppliers through withSuppliers (#799)', async () => {
    db.eventGame.findMany.mockResolvedValue([lineupRow('g1', 'att-1'), lineupRow('g2', 'att-2')] as never);
    db.eventGame.count.mockResolvedValue(2);
    db.eventAttendee.findMany.mockResolvedValue([attendee('att-1')] as never);

    const page = await service.listLineup('event-1', query());

    expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, { id: { in: ['att-1', 'att-2'] } });
    expect(db.eventAttendee.findMany).toHaveBeenCalledTimes(1);
    expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['att-1', 'att-2'] }, AND: [COND] },
      select: ATTENDEE_SUMMARY_SELECT,
    });
    expect(page.rows.map(({ id, suppliedBy }) => [id, suppliedBy])).toEqual([
      ['g1', { id: 'list-g1', attendeeId: 'att-1', attendee: attendee('att-1') }],
      ['g2', { id: 'list-g2', attendeeId: 'att-2', attendee: null }],
    ]);
    expect(page.total).toBe(2);
  });

  describe('removeLineupGame (#769)', () => {
    beforeEach(() => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: 'hh-1' } as never);
      // The event's lock, which answers whether it was cancelled.
      db.$queryRaw.mockResolvedValue([{ cancelledAt: null }] as never);
    });

    /** What the read of the game finds, then the read under the event's lock. */
    const reads = (first: unknown, underLock: unknown = null) =>
      db.eventGame.findFirst.mockResolvedValueOnce(first as never).mockResolvedValueOnce(underLock as never);

    it("answers 404 for an event that doesn't exist or was deleted (#769)", async () => {
      db.event.findUnique.mockResolvedValue(null);

      await expect(service.removeLineupGame('missing', 'eg-1')).rejects.toThrow(NotFoundException);
      expect(db.event.findUnique).toHaveBeenCalledWith({
        where: { id: 'missing', deletedAt: null },
        select: { id: true, householdId: true },
      });
      expect(db.eventGame.findFirst).not.toHaveBeenCalled();
      expect(db.eventGame.deleteMany).not.toHaveBeenCalled();
    });

    // The game is found through either parent, so a date's game is this
    // event's only while its date is.
    it('answers 404 for a game of another event, or none (#769)', async () => {
      reads(null);

      const removal = service.removeLineupGame('event-1', 'eg-9');

      await expect(removal).rejects.toThrow(NotFoundException);
      await expect(removal).rejects.toMatchObject({
        response: t('errors.lineup.not_found', { lineupGameId: 'eg-9', eventId: 'event-1' }),
      });
      expect(db.eventGame.findFirst).toHaveBeenCalledWith({
        where: { id: 'eg-9', OR: [{ eventId: 'event-1' }, { occurrence: { is: { eventId: 'event-1' } } }] },
        select: LINEUP_GAME_SELECT,
      });
      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    // The grant is checked before the lineup is judged, so a refusal never
    // says whether the game's date has started.
    it('answers 403, not 409, to an actor without the grant on a started lineup (#769)', async () => {
      reads(lineupRow('eg-1', 'att-1'), null);
      db.eventGame.count.mockResolvedValue(1);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.removeLineupGame('event-1', 'eg-1')).rejects.toThrow(ForbiddenException);
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.eventGame.deleteMany).not.toHaveBeenCalled();
    });

    // Started is the rule the automatic removals use (`lineupStillAhead`),
    // judged under the event's lock, so no date write moves a date between
    // the judgement and the delete. One code, and the copy says why for the
    // game's parent: a date that started or was called off, or an event with
    // no date still to come, which can mean every date was cancelled.
    //
    // The lock is FOR NO KEY UPDATE, which a supplier leaving waits on: under
    // a shared lock, both could read the game, and the supplier's leaving
    // would report deleting a game the removal had already deleted.
    it.each([
      { parent: "a date's game", occurrenceId: 'occ-1', message: t('errors.lineup.date_closed') },
      { parent: "the event's own game", occurrenceId: null, message: t('errors.lineup.event_closed') },
    ])(
      'answers 409 LINEUP_STARTED for $parent once its lineup has started, saying why (#769)',
      async ({ occurrenceId, message }) => {
        reads({ ...lineupRow('eg-1', 'att-1'), occurrenceId }, null);
        db.eventGame.count.mockResolvedValue(1);

        await expect(service.removeLineupGame('event-1', 'eg-1')).rejects.toMatchObject({
          status: 409,
          response: { code: 'LINEUP_STARTED', message },
        });

        const [[lock]] = db.$queryRaw.mock.calls;
        expect(rawQueryText(lock)).toBe(
          'SELECT cancelled_at AS "cancelledAt" FROM events WHERE id = ? FOR NO KEY UPDATE',
        );
        expect((lock as unknown as Prisma.Sql).values).toEqual(['event-1']);
        expect(db.eventGame.findFirst).toHaveBeenLastCalledWith({
          where: { id: 'eg-1', ...lineupStillAhead(expect.any(Date)) },
          select: LINEUP_GAME_SNAPSHOT_SELECT,
        });
        expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          db.eventGame.findFirst.mock.invocationCallOrder[1],
        );
        expect(db.eventGame.deleteMany).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      },
    );

    // Another removal, its supplier leaving, or its date's removal took it
    // off while this waited for the lock. A lost race answers 404, as #1064
    // decided, not the 409 of a lineup that has started.
    it('answers 404, not 409, when the game left the lineup before the lock (#769)', async () => {
      reads(lineupRow('eg-1', 'att-1'), null);
      db.eventGame.count.mockResolvedValue(0);

      await expect(service.removeLineupGame('event-1', 'eg-1')).rejects.toThrow(NotFoundException);
      expect(db.eventGame.count).toHaveBeenCalledWith({ where: { id: 'eg-1' } });
      expect(db.eventGame.deleteMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // Every write that deletes lineup games takes the event's lock, so this
    // is a backstop for a delete that reaches the row another way.
    it('answers 404 when the game left the lineup after it was read (#769)', async () => {
      reads(lineupRow('eg-1', 'att-1'), snapshotRow('eg-1', 'att-1'));
      db.eventGame.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.removeLineupGame('event-1', 'eg-1')).rejects.toThrow(NotFoundException);
      expect(db.eventGame.deleteMany).toHaveBeenCalledWith({ where: { id: 'eg-1' } });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // A cancelled event's lineup has started whatever its dates, so one with
    // no dates, which `lineupStillAhead` reads as still ahead, keeps its games
    // too. Read under the same lock, which a cancel or reopen waits on.
    it.each([
      { parent: "a date's game", occurrenceId: 'occ-1' },
      { parent: "the event's own game", occurrenceId: null },
    ])('answers 409 LINEUP_STARTED for $parent of a cancelled event (#769)', async ({ occurrenceId }) => {
      reads({ ...lineupRow('eg-1', 'att-1'), occurrenceId });
      db.$queryRaw.mockResolvedValue([{ cancelledAt: new Date('2026-11-01T00:00:00Z') }] as never);
      db.eventGame.count.mockResolvedValue(1);

      await expect(service.removeLineupGame('event-1', 'eg-1')).rejects.toMatchObject({
        status: 409,
        response: { code: 'LINEUP_STARTED', message: t('errors.lineup.event_cancelled') },
      });
      expect(db.eventGame.findFirst).toHaveBeenCalledTimes(1);
      expect(db.eventGame.deleteMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // Read after the commit, a failed read would answer 500 for a removal
    // that happened, and the retry would answer 404.
    it("reads the supplier's attendee before the transaction, so a failed read removes nothing (#769)", async () => {
      reads(lineupRow('eg-1', 'att-1'), snapshotRow('eg-1', 'att-1'));
      db.eventAttendee.findMany.mockRejectedValue(new Error('connection lost'));

      await expect(service.removeLineupGame('event-1', 'eg-1')).rejects.toThrow('connection lost');
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.eventGame.deleteMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // The domain event carries the game as it stood when it was deleted, and
    // the answer is the game in the lineup's shape, its supplier named under
    // the attendee read ceiling (#799).
    it('removes the game and emits its removal by the acting user (#769)', async () => {
      reads(lineupRow('eg-1', 'att-1'), snapshotRow('eg-1', 'att-1'));
      db.eventGame.deleteMany.mockResolvedValue({ count: 1 });
      db.eventAttendee.findMany.mockResolvedValue([attendee('att-1')] as never);

      const removed = await service.removeLineupGame('event-1', 'eg-1');

      expect(db.eventGame.deleteMany).toHaveBeenCalledWith({ where: { id: 'eg-1' } });
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const [eventName, emitted] = emitter.emit.mock.calls[0];
      expect(eventName).toBe(GameRemovedFromEventEvent.eventName);
      expect(emitted).toBeInstanceOf(GameRemovedFromEventEvent);
      expect(emitted.before).toEqual(snapshotRow('eg-1', 'att-1'));
      expect(emitted.after).toBeNull();
      expect(emitted.eventId).toBe('event-1');
      expect(emitted.reason).toBe(LineupRemovalReason.RemovedByHost);
      expect(emitted.actingUserId).toBe(MOCK_ACTING_USER_ID);

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, { id: { in: ['att-1'] } });
      expect(removed).toEqual({
        ...lineupRow('eg-1', 'att-1'),
        suppliedBy: { id: 'list-eg-1', attendeeId: 'att-1', attendee: attendee('att-1') },
      });
    });

    // Bound to the row on whichever parent it hangs off, as the direct add
    // binds its create, so a household's grant reaches its own events alone.
    it.each([
      {
        parent: "the event's own game through the event",
        occurrenceId: null,
        subject: { eventId: 'event-1', occurrenceId: null, event: { householdId: 'hh-1' }, occurrence: null },
      },
      {
        parent: "a date's game through its date",
        occurrenceId: 'occ-1',
        subject: {
          eventId: null,
          occurrenceId: 'occ-1',
          event: null,
          occurrence: { id: 'occ-1', eventId: 'event-1', event: { householdId: 'hh-1' } },
        },
      },
    ])("checks delete on $parent, in the event's household (#769)", async ({ occurrenceId, subject }) => {
      reads({ ...lineupRow('eg-1', 'att-1'), occurrenceId }, { ...snapshotRow('eg-1', 'att-1'), occurrenceId });
      db.eventGame.deleteMany.mockResolvedValue({ count: 1 });

      await service.removeLineupGame('event-1', 'eg-1');

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.delete, ResourceType.EventGame, subject);
    });
  });
});
