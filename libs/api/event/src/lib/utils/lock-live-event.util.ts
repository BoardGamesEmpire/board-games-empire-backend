import { liveEventWhere, Prisma, type Event } from '@bge/database';
import { t } from '@bge/i18n';
import { NotFoundException } from '@nestjs/common';
import assert from 'node:assert';

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
