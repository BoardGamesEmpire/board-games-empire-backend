import type { Event } from '@bge/database';
import { liveEventWhere, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { NotFoundException } from '@nestjs/common';
import assert from 'node:assert';
import { assertEventExists } from '../event-access.helpers';

/**
 * Locks the event's row `FOR NO KEY UPDATE` until the caller's transaction
 * ends, then reads the row again under the lock and returns it. An event
 * that isn't live answers 404 (`liveEventWhere`): one deleted itself, one
 * whose household is deleted (#992), and a missing row.
 *
 * The mode is the one an UPDATE of the row takes anyway, and the one a write
 * to the event's dates takes (`writeEventDates`), so writes to one event take
 * turns. A write that queued behind a delete finds the row deleted here and
 * answers as a request arriving after the delete would (#731, #795). Run it
 * first in the write's own transaction, and judge the write from the row it
 * returns.
 */
export async function lockLiveEvent(tx: Prisma.TransactionClient, id: string): Promise<Event> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${id} FOR NO KEY UPDATE`);

  const event = await tx.event.findUnique({ where: { id, ...liveEventWhere() } });
  assert(event, new NotFoundException(t('errors.event.not_found', { id })));

  return event;
}

/**
 * Locks the event's row `FOR SHARE` until the caller's transaction ends, then
 * checks under the lock that the event is live, answering 404 when it isn't
 * ({@link assertEventExists}): one deleted itself, or one whose household is
 * deleted (#992). Every write in this lib beneath an event that doesn't lock
 * the row already takes it, so none lands on an event a delete has taken
 * (#1065). Linking media to an event is the media lib's write, and doesn't
 * take it yet (#828).
 *
 * `FOR SHARE` conflicts with the `UPDATE` an event's delete runs, so the two
 * take turns: a write that locked first commits before the delete, and one
 * that queued behind the delete reads it deleted here and answers as a
 * request arriving after it would. `FOR KEY SHARE` would let the delete
 * through. A household's delete reads no event rows, so it needs no lock: a
 * write that read the household live counts as happening before it.
 *
 * It also holds the event's dates as they are while the caller judges which
 * lineups are still ahead (#551). A write to the dates (`writeEventDates`)
 * and a host's removal of a lineup game (`LineupService.removeLineupGame`,
 * through {@link lockLiveEvent}) take the row `FOR NO KEY UPDATE`, which
 * conflicts with this: whichever comes second waits, then sees the first.
 * Without it, a supplier could leave while a date that has started is moved
 * to a start still to come. Their leaving would read the date as started and
 * keep their game in its lineup, and the move, reading before they left,
 * would see them in the event, so the lineup would end up ahead, holding a
 * game nobody is bringing.
 *
 * Shares never wait on each other, so writes beneath one event run side by
 * side. Take it as the transaction's first lock, except after `lockSupplier`
 * where the write takes that: the supplier's rows, then the event's, then
 * nominations. Removing a date writes to the nominations that name it while
 * holding the event's row, so a nomination is locked only after it. A write
 * that takes the row `FOR NO KEY UPDATE` takes {@link lockLiveEventDates}
 * instead, and never this first: two writes that each hold the share and
 * wait to raise it would wait on each other.
 */
export async function shareLiveEvent(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${eventId} FOR SHARE`);
  await assertTakesWrites(tx, eventId);
}

/**
 * Locks the event's row `FOR NO KEY UPDATE` until the caller's transaction
 * ends, as a write to the event's dates does, then checks under the lock that
 * the event takes writes, as {@link shareLiveEvent} does (#1065). Writes to
 * one event's dates, and changes to a date's status, take turns on it, and
 * one queued behind the event's delete answers 404.
 */
export async function lockLiveEventDates(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${eventId} FOR NO KEY UPDATE`);
  await assertTakesWrites(tx, eventId);
}

/**
 * Whether the event takes writes beneath it, read under the caller's lock on
 * its row: it is live (#992, #1065). The one check both locks above run, so a
 * condition a write must also meet, such as an event not cancelled or
 * archived (#956), is added here once.
 */
async function assertTakesWrites(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
  await assertEventExists(tx, eventId);
}
