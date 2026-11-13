import { OccurrenceStatus, type Prisma } from '@bge/database';

/**
 * The statuses of a date still in play: proposed or confirmed. A declined or
 * cancelled date is not live (#796).
 */
export const LIVE_DATE_STATUSES = [OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed] as const;

/**
 * How many of an event's dates are live. Call it under the event's row lock
 * (`lockLiveEvent`, `writeEventDates`), or a date written beside it goes
 * unseen. #966 needs the same "live date" rule and reuses this.
 */
export function countLiveDates(tx: Prisma.TransactionClient, eventId: string): Promise<number> {
  return tx.eventOccurrence.count({
    where: { eventId, status: { in: [...LIVE_DATE_STATUSES] } },
  });
}
