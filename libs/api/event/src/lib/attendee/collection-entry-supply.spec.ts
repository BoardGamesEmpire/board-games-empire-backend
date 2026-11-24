import type { GameCollection, Prisma } from '@bge/database';
import { EventParticipationStatus, liveEventWhere, NominationStatus, ScheduledGameRole } from '@bge/database';
import { LineupRemovalReason } from '@bge/notifications-service';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService, rawQueryText } from '@bge/testing';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  GameRemovedFromEventEvent,
  NominationPausedEvent,
  NominationResumedEvent,
} from '../nomination/events/nomination.events';
import type { LineupGameSnapshot } from './attendance';
import { LINEUP_GAME_SNAPSHOT_SELECT, lineupStillAhead } from './attendance';
import { emitCollectionSupplyChanges, syncCollectionEntrySupply } from './collection-entry-supply';

const NOW = new Date('2026-11-23T12:00:00Z');
const REMOVED: Pick<GameCollection, 'id' | 'deletedAt'> = { id: 'col-1', deletedAt: new Date('2026-11-23T11:59:00Z') };
const ADDED_BACK: Pick<GameCollection, 'id' | 'deletedAt'> = { id: 'col-1', deletedAt: null };

/** A lineup game the collection entry supplies, through its offer at `eventId`. */
const lineupGame = (id: string, eventId: string): LineupGameSnapshot => ({
  id,
  eventId,
  occurrenceId: null,
  platformGameId: 'pg-1',
  suppliedById: `offer-${eventId}`,
  nominationId: null,
  addedById: 'att-host',
  role: ScheduledGameRole.Primary,
});

/** The shape of the nomination writes' `where`, as far as the stubs below read it. */
interface NominationWrite {
  where: {
    pausedFrom?: NominationStatus;
    status: NominationStatus;
    suppliedFrom: { is: { attendee: { is: { eventId: string } } } };
  };
}

/** The shape of the lineup read's `where`, as far as the stubs below read it. */
interface LineupRead {
  where: { suppliedBy: { is: { attendee: { is: { eventId: string } } } } };
}

describe('syncCollectionEntrySupply', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
    // Nothing is paused, resumed or taken off unless a test says so.
    tx.eventGameNomination.updateManyAndReturn.mockResolvedValue([]);
    tx.eventGame.findMany.mockResolvedValue([]);
  });

  const sync = (entry: Pick<GameCollection, 'id' | 'deletedAt'>) =>
    syncCollectionEntrySupply(tx as unknown as Prisma.TransactionClient, entry, NOW);

  /**
   * The events a live offer of the entry names (the first read), then those
   * of them still live under the lock (the second). The second defaults to
   * all of the first.
   */
  const offeredAt = (eventIds: string[], liveIds: string[] = eventIds) => {
    tx.event.findMany
      .mockResolvedValueOnce(eventIds.map((id) => ({ id })) as never)
      .mockResolvedValueOnce(liveIds.map((id) => ({ id })) as never);
  };

  // A removal of a game offered nowhere, or only by an offer taken back,
  // locks no event and changes nothing (#1221).
  it.each([
    { state: 'removal', entry: REMOVED },
    { state: 'add-back', entry: ADDED_BACK },
  ])('reads nothing more when no live offer names the entry, on $state (#1221)', async ({ entry }) => {
    offeredAt([]);

    await expect(sync(entry)).resolves.toEqual([]);

    expect(tx.event.findMany).toHaveBeenCalledTimes(1);
    expect(tx.event.findMany).toHaveBeenCalledWith({
      where: { attendees: { some: { availableGames: { some: { collectionId: 'col-1', removedAt: null } } } } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.eventGameNomination.updateManyAndReturn).not.toHaveBeenCalled();
    expect(tx.eventGame.findMany).not.toHaveBeenCalled();
    expect(tx.eventGame.deleteMany).not.toHaveBeenCalled();
  });

  // The events are locked FOR SHARE before any nomination: removing a date
  // writes to the nominations that name it while holding the event's row, so
  // a nomination locked first could deadlock with it. The database sorts
  // them, so every removal and add-back locks them in one order, whatever
  // order the read handed back. Under the lock, an event deleted a moment
  // before reads as deleted (#1221).
  it('locks the events offering the entry FOR SHARE in id order, then keeps only the live ones (#1221)', async () => {
    const order: string[] = [];
    const reads = [
      [{ id: 'event-2' }, { id: 'event-1' }],
      [{ id: 'event-1' }, { id: 'event-2' }],
    ];
    tx.event.findMany.mockImplementation((async () => {
      order.push('events read');

      return reads.shift() ?? [];
    }) as never);
    tx.$queryRaw.mockImplementation((async () => {
      order.push('events locked');

      return [];
    }) as never);
    tx.eventGameNomination.updateManyAndReturn.mockImplementation((async () => {
      order.push('nominations');

      return [];
    }) as never);
    tx.eventGame.findMany.mockImplementation((async () => {
      order.push('lineup games');

      return [];
    }) as never);

    await sync(REMOVED);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [[lock]] = tx.$queryRaw.mock.calls;
    expect(rawQueryText(lock)).toBe('SELECT id FROM events WHERE id IN (?,?) ORDER BY id FOR SHARE');
    expect((lock as unknown as Prisma.Sql).values).toEqual(['event-2', 'event-1']);
    expect(tx.event.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['event-2', 'event-1'] }, ...liveEventWhere() },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    // Each live event in turn: its nominations, then its lineup games.
    expect(order).toEqual([
      'events read',
      'events locked',
      'events read',
      'nominations',
      'nominations',
      'lineup games',
      'nominations',
      'nominations',
      'lineup games',
    ]);
  });

  // Each nomination of the game that awaits an outcome pauses, whoever made
  // it, and remembers the status it paused from. The game leaves the lineup
  // of every date still ahead, and is not put back when the game is added
  // back (#1221).
  it('on removal, pauses each nomination awaiting an outcome per status and takes the lineup games still ahead off, per live event (#1221)', async () => {
    offeredAt(['event-1', 'event-2']);
    tx.eventGameNomination.updateManyAndReturn.mockImplementation((async ({ where }: NominationWrite) => [
      { id: `${where.suppliedFrom.is.attendee.is.eventId}-${where.status}` },
    ]) as never);
    tx.eventGame.findMany.mockImplementation((async ({ where }: LineupRead) => [
      lineupGame(`lg-${where.suppliedBy.is.attendee.is.eventId}`, where.suppliedBy.is.attendee.is.eventId),
    ]) as never);

    const changes = await sync(REMOVED);

    const pauses = [
      ['event-1', NominationStatus.Open],
      ['event-1', NominationStatus.AwaitingApproval],
      ['event-2', NominationStatus.Open],
      ['event-2', NominationStatus.AwaitingApproval],
    ] as const;
    expect(tx.eventGameNomination.updateManyAndReturn).toHaveBeenCalledTimes(pauses.length);
    pauses.forEach(([eventId, status], index) => {
      expect(tx.eventGameNomination.updateManyAndReturn).toHaveBeenNthCalledWith(index + 1, {
        where: { suppliedFrom: { is: { collectionId: 'col-1', attendee: { is: { eventId } } } }, status },
        data: { status: NominationStatus.Paused, pausedFrom: status },
        select: { id: true },
      });
    });

    for (const eventId of ['event-1', 'event-2']) {
      expect(tx.eventGame.findMany).toHaveBeenCalledWith({
        where: {
          suppliedBy: { is: { collectionId: 'col-1', attendee: { is: { eventId } } } },
          ...lineupStillAhead(NOW),
        },
        select: LINEUP_GAME_SNAPSHOT_SELECT,
      });
      expect(tx.eventGame.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [`lg-${eventId}`] } } });
    }

    expect(changes).toEqual(
      ['event-1', 'event-2'].map((eventId) => ({
        eventId,
        changes: {
          paused: [NominationStatus.Open, NominationStatus.AwaitingApproval].map((status) => ({
            id: `${eventId}-${status}`,
            from: status,
            to: NominationStatus.Paused,
          })),
          resumed: [],
          removedGames: [lineupGame(`lg-${eventId}`, eventId)],
        },
      })),
    );
  });

  // Only a nomination whose attendee is in the event resumes: one whose
  // attendee is out stays paused until they are back, when their own return
  // resumes it (#1221).
  it('on add-back, resumes paused nominations whose attendee is in the event, to the status each paused from (#1221)', async () => {
    offeredAt(['event-1']);
    tx.eventGameNomination.updateManyAndReturn.mockImplementation((async ({ where }: NominationWrite) =>
      where.pausedFrom === NominationStatus.Open ? [{ id: 'nom-1' }] : []) as never);

    const changes = await sync(ADDED_BACK);

    expect(tx.eventGameNomination.updateManyAndReturn).toHaveBeenCalledTimes(2);
    [NominationStatus.Open, NominationStatus.AwaitingApproval].forEach((status, index) => {
      expect(tx.eventGameNomination.updateManyAndReturn).toHaveBeenNthCalledWith(index + 1, {
        where: {
          suppliedFrom: {
            is: {
              collectionId: 'col-1',
              attendee: {
                is: { eventId: 'event-1', removedAt: null, status: { not: EventParticipationStatus.NotAttending } },
              },
            },
          },
          status: NominationStatus.Paused,
          pausedFrom: status,
        },
        data: { status, pausedFrom: null },
        select: { id: true },
      });
    });
    // A lineup game that left is not put back: the host may have filled the
    // slot since.
    expect(tx.eventGame.findMany).not.toHaveBeenCalled();
    expect(tx.eventGame.deleteMany).not.toHaveBeenCalled();
    expect(changes).toEqual([
      {
        eventId: 'event-1',
        changes: {
          paused: [],
          resumed: [{ id: 'nom-1', from: NominationStatus.Paused, to: NominationStatus.Open }],
          removedGames: [],
        },
      },
    ]);
  });

  // An event deleted, or in a household that is deleted, keeps its
  // nominations and lineup as they stand, and reports nothing (#1221).
  it.each([
    { state: 'removal', entry: REMOVED },
    { state: 'add-back', entry: ADDED_BACK },
  ])('leaves a deleted event alone, on $state (#1221)', async ({ entry }) => {
    offeredAt(['event-1', 'event-2'], ['event-2']);
    tx.eventGameNomination.updateManyAndReturn.mockImplementation((async ({ where }: NominationWrite) => [
      { id: `${where.suppliedFrom.is.attendee.is.eventId}-${where.pausedFrom ?? where.status}` },
    ]) as never);

    const changes = await sync(entry);

    for (const [{ where }] of tx.eventGameNomination.updateManyAndReturn.mock.calls as unknown as [NominationWrite][]) {
      expect(where.suppliedFrom.is.attendee.is.eventId).toBe('event-2');
    }

    for (const [{ where }] of tx.eventGame.findMany.mock.calls as unknown as [LineupRead][]) {
      expect(where.suppliedBy.is.attendee.is.eventId).toBe('event-2');
    }

    expect(changes.map(({ eventId }) => eventId)).toEqual(['event-2']);
  });

  it('returns only events with a change (#1221)', async () => {
    offeredAt(['event-1', 'event-2', 'event-3']);
    // event-2 has a nomination to pause; event-3 only a lineup game to take
    // off; event-1 nothing.
    tx.eventGameNomination.updateManyAndReturn.mockImplementation((async ({ where }: NominationWrite) =>
      where.suppliedFrom.is.attendee.is.eventId === 'event-2' && where.status === NominationStatus.Open
        ? [{ id: 'nom-2' }]
        : []) as never);
    tx.eventGame.findMany.mockImplementation((async ({ where }: LineupRead) =>
      where.suppliedBy.is.attendee.is.eventId === 'event-3' ? [lineupGame('lg-3', 'event-3')] : []) as never);

    const changes = await sync(REMOVED);

    expect(changes).toEqual([
      {
        eventId: 'event-2',
        changes: {
          paused: [{ id: 'nom-2', from: NominationStatus.Open, to: NominationStatus.Paused }],
          resumed: [],
          removedGames: [],
        },
      },
      { eventId: 'event-3', changes: { paused: [], resumed: [], removedGames: [lineupGame('lg-3', 'event-3')] } },
    ]);
    expect(tx.eventGame.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.eventGame.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['lg-3'] } } });
  });
});

describe('emitCollectionSupplyChanges', () => {
  // The lineup games leave because the attendee supplying them removed the
  // game from their collection, which the notification says (#1221).
  it('emits pause, resume and lineup removal with reason RemovedFromCollection (#1221)', () => {
    const emitter = { emit: jest.fn() };
    const initiatedAt = new Date('2026-11-23T12:00:00Z');
    const removedGame = lineupGame('lg-1', 'event-1');

    emitCollectionSupplyChanges(
      emitter as unknown as EventEmitter2,
      [
        {
          eventId: 'event-1',
          changes: {
            paused: [{ id: 'nom-1', from: NominationStatus.Open, to: NominationStatus.Paused }],
            resumed: [],
            removedGames: [removedGame],
          },
        },
        {
          eventId: 'event-2',
          changes: {
            paused: [],
            resumed: [{ id: 'nom-2', from: NominationStatus.Paused, to: NominationStatus.AwaitingApproval }],
            removedGames: [],
          },
        },
      ],
      'user-owner',
      initiatedAt,
    );

    expect(emitter.emit.mock.calls.map(([name]) => name)).toEqual([
      NominationPausedEvent.eventName,
      GameRemovedFromEventEvent.eventName,
      NominationResumedEvent.eventName,
    ]);

    const [[, paused], [, removed], [, resumed]] = emitter.emit.mock.calls;
    expect(paused).toBeInstanceOf(NominationPausedEvent);
    expect(paused).toMatchObject({
      before: { id: 'nom-1', eventId: 'event-1', status: NominationStatus.Open },
      after: { id: 'nom-1', eventId: 'event-1', status: NominationStatus.Paused },
      initiatedAt,
    });
    expect(removed).toBeInstanceOf(GameRemovedFromEventEvent);
    expect(removed).toMatchObject({
      before: removedGame,
      eventId: 'event-1',
      reason: LineupRemovalReason.RemovedFromCollection,
      actingUserId: 'user-owner',
      initiatedAt,
    });
    expect(resumed).toBeInstanceOf(NominationResumedEvent);
    expect(resumed).toMatchObject({
      before: { id: 'nom-2', eventId: 'event-2', status: NominationStatus.Paused },
      after: { id: 'nom-2', eventId: 'event-2', status: NominationStatus.AwaitingApproval },
      initiatedAt,
    });
  });
});
