import { Action, DatabaseService, Prisma, ResourceType } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { LineupRemovalReason } from '@bge/notifications-service';
import { AbilityService, resolveActingUserIdOrNull, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows } from '@bge/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import {
  emitRemovedGames,
  LINEUP_GAME_SNAPSHOT_SELECT,
  lineupStillAhead,
  lockEventForLineupRemoval,
} from '../attendee/attendance';
import { assertEventExists, requireEvent } from '../event-access.helpers';
import type { ListLineupQueryDto } from './dto/list-lineup.query.dto';
import { LINEUP_GAME_SELECT, lineupGameSubject, withSuppliers, type LineupGame } from './lineup-game';
import { readableLineupWhere } from './lineup-scope';

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

/**
 * An event's lineup, read as one list: its own games and each date's (#799).
 * A host takes a game out of it here too (#769).
 */
@Injectable()
export class LineupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scopeComposer: ScopeComposer,
    private readonly abilityService: AbilityService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * One page of the event's lineup, as far as the actor may read it (#799).
   *
   * - The rows are the event's own games and the games of each date the
   *   actor can read ({@link readableLineupWhere}).
   * - `occurrenceId` narrows the page to that date's games. Only that date is
   *   read for whether the actor can read it, and it is ANDed beside it, so
   *   a date the actor can't read lists nothing.
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

    const where = this.scopeComposer.compose(ResourceType.EventGame, Action.read, {
      ...(await readableLineupWhere(
        this.db,
        this.scopeComposer,
        eventId,
        query.occurrenceId ? [query.occurrenceId] : undefined,
      )),
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

  /**
   * Takes a game out of the lineup, the event's own or a date's, and answers
   * it in the lineup's shape (#769).
   *
   * - A game that isn't in this event's lineup answers 404.
   * - The grant is checked against the game on whichever parent it hangs
   *   off, as the direct add checks its create ({@link lineupGameSubject}),
   *   and before the lineup is judged, so a 403 never says whether it has
   *   started.
   * - A game whose lineup has started stays, as the record of what was
   *   planned, and answers 409. "Started" is the rule the automatic removals
   *   use ({@link lineupStillAhead}). It covers a date that was called off,
   *   and an event whose dates were all cancelled, so the copy says which.
   *   A cancelled event's lineup has started whatever its dates, so one with
   *   no dates keeps its games too.
   * - Both are judged under the event's lock ({@link lockEventForLineupRemoval}),
   *   which a date write, a cancel and a supplier leaving also take, so none
   *   of them changes the answer before the delete, and a supplier leaving
   *   never reports the same game gone. "Started" is judged at the time of
   *   that read, not when the request began, since the lock may have waited
   *   past a date's start, as a date's confirm judges it (#1005).
   * - A removal that loses a race, to another removal, the supplier leaving
   *   or a date write, answers 404, as #1064 decided for lost races: whether
   *   the game left before the lock or while this waited on it. So does one
   *   that loses to the event's delete, which keeps the lineup's rows: the
   *   event is read again under the lock.
   *
   * The answer is read before the transaction, from the game as first found,
   * so no read follows the commit: a failed one would report a removal that
   * happened as one that didn't. The domain event carries the game as the
   * read under the lock found it, and is emitted once the transaction
   * commits. The nomination that put the game there keeps its outcome, and
   * its `elevatedTo` reads `null` from then on.
   */
  async removeLineupGame(eventId: string, lineupGameId: string): Promise<LineupGame> {
    const initiatedAt = new Date();
    const actingUserId = resolveActingUserIdOrNull(this.abilityService);
    const notFound = () => new NotFoundException(t('errors.lineup.not_found', { lineupGameId, eventId }));
    const event = await requireEvent(this.db, eventId);

    const found = await this.db.eventGame.findFirst({
      where: { id: lineupGameId, OR: [{ eventId }, { occurrence: { is: { eventId } } }] },
      select: LINEUP_GAME_SELECT,
    });

    if (!found) {
      throw notFound();
    }

    this.abilityService.assertCurrentActorCan(
      Action.delete,
      ResourceType.EventGame,
      lineupGameSubject(eventId, event.householdId, found.occurrenceId),
    );

    const [removed] = await withSuppliers(this.db, this.scopeComposer, [found]);

    const snapshot = await this.db.$transaction(async (tx) => {
      const locked = await lockEventForLineupRemoval(tx, eventId);

      if (!locked) {
        throw new NotFoundException(t('errors.event.not_found', { id: eventId }));
      }

      const ahead = locked.cancelledAt
        ? null
        : await tx.eventGame.findFirst({
            where: { id: lineupGameId, ...lineupStillAhead(new Date()) },
            select: LINEUP_GAME_SNAPSHOT_SELECT,
          });

      if (!ahead) {
        // Gone, rather than started: it left the lineup while this waited.
        if ((await tx.eventGame.count({ where: { id: lineupGameId } })) === 0) {
          throw notFound();
        }

        throw new CodedHttpException(Http.Conflict, 'LINEUP_STARTED', t(closedCopy(locked, found.occurrenceId)));
      }

      const { count } = await tx.eventGame.deleteMany({ where: { id: lineupGameId } });

      if (count === 0) {
        throw notFound();
      }

      return ahead;
    });

    emitRemovedGames(
      this.eventEmitter,
      eventId,
      [snapshot],
      LineupRemovalReason.RemovedByHost,
      actingUserId,
      initiatedAt,
    );

    return removed;
  }
}

/**
 * Why a lineup has started, for the 409 that keeps its game: the event was
 * called off, the game's date has started or was called off, or none of the
 * event's dates is still to come.
 */
function closedCopy(
  event: { cancelledAt: Date | null },
  occurrenceId: string | null,
): 'errors.lineup.event_cancelled' | 'errors.lineup.date_closed' | 'errors.lineup.event_closed' {
  if (event.cancelledAt) {
    return 'errors.lineup.event_cancelled';
  }

  return occurrenceId ? 'errors.lineup.date_closed' : 'errors.lineup.event_closed';
}
