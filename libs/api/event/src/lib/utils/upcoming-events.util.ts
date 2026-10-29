import { OccurrenceStatus, Prisma, type DatabaseService } from '@bge/database';
import { type PaginatedRows } from '@bge/shared';
import { OCCURRENCE_ORDER } from '../constants/occurrence-order.constant';
import { withEventStatus, type EventWithStatus } from './event-status.util';

/**
 * A date that hasn't ended at `now`: Confirmed, with a start, and its start or
 * its end still ahead. It is `deriveEventStatus`'s window, where a date with
 * no end ends at its start and an end before its start is clamped up to it, so
 * an event with such a date reads Scheduled or Ongoing (#962).
 */
export function upcomingDateWhere(now: Date): Prisma.EventOccurrenceWhereInput {
  return {
    status: OccurrenceStatus.Confirmed,
    startDate: { not: null },
    OR: [{ startDate: { gt: now } }, { endDate: { gt: now } }],
  };
}

/**
 * An event that can still take place: live, not cancelled, not archived. It is
 * `upcomingEventWhere` without the date test, for a read whose rows are
 * already dates that haven't ended (#962).
 */
function standingEventWhere(): Prisma.EventWhereInput {
  return { deletedAt: null, cancelledAt: null, archivedAt: null };
}

/**
 * An upcoming event at `now`: live, not cancelled, not archived, with a date
 * that hasn't ended. An event with no date, a poll still choosing one, is left
 * out (#962).
 */
export function upcomingEventWhere(now: Date): Prisma.EventWhereInput {
  return { ...standingEventWhere(), occurrences: { some: upcomingDateWhere(now) } };
}

/**
 * One page of upcoming events, soonest first: ordered by the start of each
 * event's earliest date that hasn't ended, then by id (#962). A multi-day
 * event whose first day is past sorts by the day still ahead. Each row is a
 * `GET /events` row: the event, every date in `OCCURRENCE_ORDER`, the policy,
 * and the status those dates give it.
 *
 * `where` is the read's composed clause: which events, its scope limited by
 * the ceiling. The helper adds when, `upcomingEventWhere(now)`, to the page
 * and the count alike, so they describe one population whatever `where` a list
 * hands over, and every row reads Scheduled or Ongoing at the `now` its status
 * is worked out at.
 *
 * Prisma can't order events by an aggregate of only some of their dates, so
 * the page's ids come from a `groupBy` over the dates that haven't ended,
 * narrowed to the events `where` matches. Each of those dates already gives
 * its event a date that hasn't ended, so the `groupBy` tests its event with
 * `standingEventWhere` rather than repeat that test for every row. A deny-all ceiling nested under
 * `event: { is }` there is still enforced: the CASL extension inspects every
 * operation's `args.where`, `groupBy` included, and hoists it. The ceiling must
 * never sit in an `include` or `select` filter, which the extension doesn't
 * inspect.
 *
 * The ids, the count and the rows come from one REPEATABLE READ transaction,
 * so `total` describes the page served (#372).
 *
 * Shared with each list of upcoming events, not with their scopes: browsing
 * (#962), a household's events (#506) and the public events (#820) each pass
 * their own `where`.
 */
export async function pageUpcomingEvents(
  db: DatabaseService,
  where: Prisma.EventWhereInput,
  page: { skip: number; take: number },
  now: Date,
): Promise<PaginatedRows<EventWithStatus>> {
  const upcoming: Prisma.EventWhereInput = { AND: [upcomingEventWhere(now), where] };
  const standing: Prisma.EventWhereInput = { AND: [standingEventWhere(), where] };

  return db.$transaction(
    async (tx) => {
      const groups = await tx.eventOccurrence.groupBy({
        by: ['eventId'],
        where: { ...upcomingDateWhere(now), event: { is: standing } },
        _min: { startDate: true },
        orderBy: [{ _min: { startDate: 'asc' } }, { eventId: 'asc' }],
        skip: page.skip,
        take: page.take,
      });

      const total = await tx.event.count({ where: upcoming });
      const ids = groups.map(({ eventId }) => eventId);

      if (ids.length === 0) {
        return { rows: [], total };
      }

      const events = await tx.event.findMany({
        where: { id: { in: ids } },
        include: { occurrences: { orderBy: OCCURRENCE_ORDER }, policy: true },
      });

      // The snapshot holds every id the page named, so each one finds its row.
      const byId = new Map(events.map((event) => [event.id, event]));
      const rows = ids.flatMap((id) => {
        const event = byId.get(id);
        return event ? [withEventStatus(event, event.occurrences, now)] : [];
      });

      return { rows, total };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
