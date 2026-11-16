import type { DatabaseService } from '@bge/database';
import type { ScopeComposer } from '@bge/permissions';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { LINEUP_GAME_SELECT, toLineupGameRow, withSuppliers, type LineupGameRow } from './lineup-game';

const CEILING = { id: { in: ['att-host'] }, AND: [{ id: 'sentinel-condition' }] };

const row = (id: string, attendeeId: string): LineupGameRow =>
  ({
    id,
    occurrenceId: 'occ-1',
    platformGameId: `pg-${id}`,
    role: 'Primary',
    sortOrder: 0,
    notes: null,
    maxPlayTime: null,
    nominationId: null,
    addedById: null,
    platformGame: { id: `pg-${id}` },
    suppliedBy: { id: `list-${id}`, attendeeId },
  }) as unknown as LineupGameRow;

describe('lineup games (#799)', () => {
  let db: MockDatabaseService;

  const name = (rows: LineupGameRow[]) =>
    withSuppliers(
      db as unknown as DatabaseService,
      { compose: jest.fn().mockReturnValue(CEILING) } as unknown as ScopeComposer,
      rows,
    );

  beforeEach(() => {
    db = createMockDatabaseService();
    db.eventAttendee.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  describe('withSuppliers', () => {
    it("names each supplier's attendee, read once for all rows (#799)", async () => {
      const host = {
        id: 'att-host',
        status: 'attending',
        guestName: null,
        user: { id: 'u1', username: 'host', profile: null },
      };
      db.eventAttendee.findMany.mockResolvedValue([host] as never);

      const games = await name([row('g1', 'att-host'), row('g2', 'att-host')]);

      expect(db.eventAttendee.findMany).toHaveBeenCalledTimes(1);
      expect(games.map(({ suppliedBy }) => suppliedBy)).toEqual([
        { id: 'list-g1', attendeeId: 'att-host', attendee: host },
        { id: 'list-g2', attendeeId: 'att-host', attendee: host },
      ]);
    });

    it("serves attendee null where the actor can't read the supplier (#799)", async () => {
      const [game] = await name([row('g1', 'att-host')]);

      expect(game.suppliedBy).toEqual({ id: 'list-g1', attendeeId: 'att-host', attendee: null });
    });

    it("keeps a guest supplier's attendee, with user null and guestName set (#799)", async () => {
      const guest = { id: 'att-guest', status: 'attending', guestName: 'Pat', user: null };
      db.eventAttendee.findMany.mockResolvedValue([guest] as never);

      const [game] = await name([row('g1', 'att-guest')]);

      expect(game.suppliedBy.attendee).toEqual({ id: 'att-guest', status: 'attending', guestName: 'Pat', user: null });
    });

    it('keeps the rest of the row as read (#799)', async () => {
      const [game] = await name([row('g1', 'att-host')]);

      expect(game).toEqual(expect.objectContaining({ id: 'g1', occurrenceId: 'occ-1', platformGameId: 'pg-g1' }));
    });
  });

  describe('toLineupGameRow', () => {
    it("keeps only the select's keys (#799)", () => {
      const kept = toLineupGameRow({
        ...row('g1', 'att-host'),
        eventId: 'event-1',
        suppliedById: 'list-g1',
        createdAt: 1,
      });

      expect(Object.keys(kept).sort()).toEqual(Object.keys(LINEUP_GAME_SELECT).sort());
    });
  });
});
