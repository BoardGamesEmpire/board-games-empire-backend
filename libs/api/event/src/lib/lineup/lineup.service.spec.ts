import { Action, EventParticipationStatus, Prisma, ResourceType, ScheduledGameRole } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { ATTENDEE_SUMMARY_SELECT } from '../attendee/attendee-summary';
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
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    const abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);

    const ctx = await createTestingModuleWithDb({
      providers: [
        LineupService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the reads actually run.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
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
});
