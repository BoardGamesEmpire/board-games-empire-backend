import { EventStatus, OccurrenceStatus, Prisma, type DatabaseService } from '@bge/database';
import {
  createMockDatabaseService,
  makeEvent,
  makeEventOccurrence,
  makeEventPolicy,
  type MockDatabaseService,
} from '@bge/testing';
import { OCCURRENCE_ORDER } from '../constants/occurrence-order.constant';
import { pageUpcomingEvents, upcomingDateWhere, upcomingEventWhere } from './upcoming-events.util';

const now = new Date('2026-11-01T12:00:00Z');
const hoursFromNow = (hours: number) => new Date(now.getTime() + hours * 60 * 60 * 1000);

/** A composed where, as a service hands it over: which events, saying nothing of when. */
const WHERE = { id: 'sentinel-where' } satisfies Prisma.EventWhereInput;

/** The events the helper pages: the upcoming ones among `WHERE`. */
const UPCOMING = { AND: [upcomingEventWhere(now), WHERE] };

/** The events a date that hasn't ended may belong to: those among `WHERE` that can still take place. */
const STANDING = { AND: [{ deletedAt: null, cancelledAt: null, archivedAt: null }, WHERE] };

/**
 * "Upcoming" is `deriveEventStatus`'s window, so every row the helper pages
 * reads Scheduled or Ongoing (#962).
 */
describe('upcomingDateWhere (#962)', () => {
  // A date with no end ends at its start, so `startDate > now` covers it. An
  // end before its start is clamped up to the start, which the same branch
  // covers.
  it('counts a Confirmed date with a start whose start or end is still ahead', () => {
    expect(upcomingDateWhere(now)).toEqual({
      status: OccurrenceStatus.Confirmed,
      startDate: { not: null },
      OR: [{ startDate: { gt: now } }, { endDate: { gt: now } }],
    });
  });
});

describe('upcomingEventWhere (#962)', () => {
  // An event with no date, a poll still choosing one, has no such date and is
  // left out.
  it('declares a live, uncancelled, unarchived event with such a date', () => {
    expect(upcomingEventWhere(now)).toEqual({
      deletedAt: null,
      cancelledAt: null,
      archivedAt: null,
      occurrences: { some: upcomingDateWhere(now) },
    });
  });
});

describe('pageUpcomingEvents (#962)', () => {
  let db: MockDatabaseService;
  // Prisma's `groupBy` signature is too generic for the mock's mapped type to
  // carry, so the spec holds it as a plain mock.
  let groupBy: jest.Mock;

  const page = () => pageUpcomingEvents(db as unknown as DatabaseService, WHERE, { skip: 25, take: 25 }, now);

  beforeEach(() => {
    db = createMockDatabaseService();
    db.$transaction.mockImplementation((cb) => cb(db));
    groupBy = db.eventOccurrence.groupBy as unknown as jest.Mock;
    groupBy.mockResolvedValue([]);
    db.event.count.mockResolvedValue(0);
    db.event.findMany.mockResolvedValue([]);
  });

  // Prisma can't order events by an aggregate of only some of their dates, so
  // the page is cut from the dates instead. The dates that have ended are left
  // out of the aggregate: a multi-day event whose first day is past sorts by
  // the day still ahead. Each date read is one that hasn't ended, so its event
  // isn't asked for such a date again.
  it("orders the page by each event's soonest date that hasn't ended, then id", async () => {
    await page();

    expect(groupBy).toHaveBeenCalledWith({
      by: ['eventId'],
      where: { ...upcomingDateWhere(now), event: { is: STANDING } },
      _min: { startDate: true },
      orderBy: [{ _min: { startDate: 'asc' } }, { eventId: 'asc' }],
      skip: 25,
      take: 25,
    });
  });

  // The helper says "upcoming" itself, for the page and the count alike, so
  // they describe one population whatever `where` a list hands over.
  it('counts only the upcoming events among the where it is given', async () => {
    await page();

    expect(db.event.count).toHaveBeenCalledWith({ where: UPCOMING });
  });

  it('reads the rows by id with every date and the policy, and serves them in page order', async () => {
    groupBy.mockResolvedValue([{ eventId: 'b' }, { eventId: 'a' }]);
    db.event.findMany.mockResolvedValue([
      {
        ...makeEvent({ id: 'a' }),
        occurrences: [makeEventOccurrence({ eventId: 'a', startDate: hoursFromNow(2), endDate: null })],
        policy: makeEventPolicy('a'),
      },
      {
        ...makeEvent({ id: 'b' }),
        occurrences: [makeEventOccurrence({ eventId: 'b', startDate: hoursFromNow(-1), endDate: hoursFromNow(1) })],
        policy: makeEventPolicy('b'),
      },
    ] as never);

    const { rows } = await page();

    expect(db.event.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['b', 'a'] } },
      include: { occurrences: { orderBy: OCCURRENCE_ORDER }, policy: true },
    });
    expect(rows.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'b', status: EventStatus.Ongoing },
      { id: 'a', status: EventStatus.Scheduled },
    ]);
  });

  it('reads no rows for an empty page, and still counts', async () => {
    db.event.count.mockResolvedValue(7);

    await expect(page()).resolves.toEqual({ rows: [], total: 7 });
    expect(db.event.findMany).not.toHaveBeenCalled();
  });

  // #372: `total` describes the page served, so an event
  // created or deleted between the statements can't set them apart.
  it('takes the ids, the count and the rows from one REPEATABLE READ transaction', async () => {
    await page();

    const [, options] = db.$transaction.mock.calls[0] as unknown as [unknown, unknown];
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });
});
