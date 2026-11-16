import { Action, DatabaseService, Prisma, ResourceType } from '@bge/database';
import { ScopeComposer } from '@bge/permissions';
import type { PaginatedRows } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import { assertEventExists } from '../event-access.helpers';
import type { ListLineupQueryDto } from './dto/list-lineup.query.dto';
import { LINEUP_GAME_SELECT, withSuppliers, type LineupGame } from './lineup-game';

/**
 * The lineup's order (#799): each date's games, the dates in their own order,
 * then the event's own games. An event's own game has no date, and Postgres
 * sorts a null last on an ascending key. Within a date, or the event, the
 * order is the host's, then id, as the date reads order their games.
 */
const LINEUP_ORDER = [
  { occurrence: { sortOrder: 'asc' } },
  { occurrenceId: 'asc' },
  { sortOrder: 'asc' },
  { id: 'asc' },
] satisfies Prisma.EventGameOrderByWithRelationInput[];

/** An event's lineup, read as one list: its own games and each date's (#799). */
@Injectable()
export class LineupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of the event's lineup, as far as the actor may read it (#799).
   *
   * - The rows are the event's own games and the games of each date the
   *   actor can read. The lineup's read ceiling names a date's games through
   *   the date's event, so it can't keep them from an actor who reads the
   *   lineup but not the date: the dates are read first, under their own
   *   ceiling, and only their games are read.
   * - `occurrenceId` narrows the page to that date's games. It is ANDed beside
   *   the readable dates, so a date the actor can't read lists nothing.
   * - The rows and the count share one REPEATABLE READ snapshot, so `total`
   *   agrees with the rows. The order is {@link LINEUP_ORDER}.
   * - Each row's supplier is read once for the page, under the attendee read
   *   ceiling, and is `null` for an actor who can't read them.
   *
   * The existence probe runs first, so a missing event answers 404 rather
   * than an empty page. As in `getOccurrences`, an event deleted between the
   * probe and the read answers its rows.
   */
  async listLineup(eventId: string, query: ListLineupQueryDto): Promise<PaginatedRows<LineupGame>> {
    await assertEventExists(this.db, eventId);

    const dates = await this.db.eventOccurrence.findMany({
      where: this.scopeComposer.compose(ResourceType.EventOccurrence, Action.read, { eventId }),
      select: { id: true },
    });

    const where = this.scopeComposer.compose(ResourceType.EventGame, Action.read, {
      OR: [{ eventId }, { occurrenceId: { in: dates.map(({ id }) => id) } }],
      occurrenceId: query.occurrenceId,
    });

    const [rows, total] = await this.db.$transaction(
      [
        this.db.eventGame.findMany({
          where,
          select: LINEUP_GAME_SELECT,
          orderBy: LINEUP_ORDER,
          skip: query.skip,
          take: query.pageSize,
        }),

        this.db.eventGame.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: await withSuppliers(this.db, this.scopeComposer, rows), total };
  }
}
