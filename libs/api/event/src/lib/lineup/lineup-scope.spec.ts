import { Action, type DatabaseService, ResourceType } from '@bge/database';
import type { ScopeComposer } from '@bge/permissions';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { readableLineupGamesByNomination, readableLineupWhere } from './lineup-scope';

const CEILING = { eventId: 'event-1', AND: [{ id: 'sentinel-condition' }] };

describe('lineup scope (#799)', () => {
  let db: MockDatabaseService;
  let compose: jest.Mock;

  beforeEach(() => {
    db = createMockDatabaseService();
    compose = jest.fn().mockReturnValue(CEILING);
    db.eventOccurrence.findMany.mockResolvedValue([{ id: 'occ-1' }, { id: 'occ-2' }] as never);
    db.eventGame.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  describe('readableLineupWhere', () => {
    const where = (dateIds?: string[]) =>
      readableLineupWhere(
        db as unknown as DatabaseService,
        { compose } as unknown as ScopeComposer,
        'event-1',
        dateIds,
      );

    // The lineup's ceiling names a date's games through the date's event, so an
    // actor who reads the lineup but not the date would get them. The dates
    // read under their own ceiling decides which dates' games are named.
    it('names the event and each date the actor can read, the dates read under the date read ceiling (#799)', async () => {
      const readable = await where();

      expect(compose).toHaveBeenCalledWith(ResourceType.EventOccurrence, Action.read, { eventId: 'event-1' });
      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({ where: CEILING, select: { id: true } });
      expect(readable).toEqual({ OR: [{ eventId: 'event-1' }, { occurrenceId: { in: ['occ-1', 'occ-2'] } }] });
    });

    it('reads only the dates given (#799)', async () => {
      db.eventOccurrence.findMany.mockResolvedValue([{ id: 'occ-1' }] as never);

      const readable = await where(['occ-1', 'occ-3']);

      expect(compose).toHaveBeenCalledWith(ResourceType.EventOccurrence, Action.read, {
        eventId: 'event-1',
        id: { in: ['occ-1', 'occ-3'] },
      });
      expect(readable).toEqual({ OR: [{ eventId: 'event-1' }, { occurrenceId: { in: ['occ-1'] } }] });
    });

    it("reads no date when given none, naming the event's own games alone (#799)", async () => {
      const readable = await where([]);

      expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
      expect(readable).toEqual({ OR: [{ eventId: 'event-1' }, { occurrenceId: { in: [] } }] });
    });
  });

  // In the nominations' include, the lineup game would reach an actor who
  // can't read the lineup. It is read on its own, keyed by nomination: a
  // lineup game names its nomination uniquely, so each has one at most. As
  // the lineup read does, it names a date's game only through a date the
  // actor can read.
  describe('readableLineupGamesByNomination', () => {
    const lineupGames = (nominationIds: string[], dateIds: string[]) =>
      readableLineupGamesByNomination(
        db as unknown as DatabaseService,
        { compose } as unknown as ScopeComposer,
        'event-1',
        { nominationIds, dateIds },
      );

    /** The scope the lineup game read declares, for event-1 and the readable dates given. */
    const lineupGamesScope = (nominationIds: string[], readableDateIds: string[]) => ({
      nominationId: { in: nominationIds },
      OR: [{ eventId: 'event-1' }, { occurrenceId: { in: readableDateIds } }],
    });

    // A lineup game is on its nomination's date, so only the dates the
    // nominations name are read.
    it("reads each nomination's lineup game under the lineup read ceiling, through the dates named (#799)", async () => {
      db.eventOccurrence.findMany.mockResolvedValue([{ id: 'occ-1' }] as never);
      db.eventGame.findMany.mockResolvedValue([{ id: 'eg-1', occurrenceId: 'occ-1', nominationId: 'nom-1' }] as never);

      const games = await lineupGames(['nom-1', 'nom-2'], ['occ-1']);

      expect(compose).toHaveBeenCalledWith(ResourceType.EventOccurrence, Action.read, {
        eventId: 'event-1',
        id: { in: ['occ-1'] },
      });
      expect(compose).toHaveBeenCalledWith(
        ResourceType.EventGame,
        Action.read,
        lineupGamesScope(['nom-1', 'nom-2'], ['occ-1']),
      );
      expect(db.eventGame.findMany).toHaveBeenCalledWith({
        where: CEILING,
        select: { id: true, occurrenceId: true, nominationId: true },
      });
      expect([...games]).toEqual([['nom-1', { id: 'eg-1', occurrenceId: 'occ-1' }]]);
    });

    // A key holding read on nominations and the lineup but no date: the
    // lineup read withholds the date's game from it, and so does the link.
    it("names a date's game only through a date the actor can read, and keeps the event's own (#799)", async () => {
      db.eventOccurrence.findMany.mockResolvedValue([]);
      // What the database answers under the scope asserted below.
      db.eventGame.findMany.mockResolvedValue([{ id: 'eg-1', occurrenceId: null, nominationId: 'nom-1' }] as never);

      const games = await lineupGames(['nom-1', 'nom-2'], ['occ-1']);

      expect(compose).toHaveBeenCalledWith(
        ResourceType.EventGame,
        Action.read,
        lineupGamesScope(['nom-1', 'nom-2'], []),
      );
      expect([...games]).toEqual([['nom-1', { id: 'eg-1', occurrenceId: null }]]);
    });

    it('reads no date when no nomination names one (#799)', async () => {
      await lineupGames(['nom-1', 'nom-2'], []);

      expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
      expect(compose).toHaveBeenCalledWith(
        ResourceType.EventGame,
        Action.read,
        lineupGamesScope(['nom-1', 'nom-2'], []),
      );
    });

    it('reads nothing for no nominations, as on an empty page (#799)', async () => {
      const games = await lineupGames([], []);

      expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
      expect(db.eventGame.findMany).not.toHaveBeenCalled();
      expect(games.size).toBe(0);
    });
  });
});
