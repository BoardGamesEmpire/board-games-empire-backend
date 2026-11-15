import type { EventOccurrence, Prisma } from '@bge/database';

/** The two columns a date's end is worked out from. */
export type DateWindow = Pick<EventOccurrence, 'startDate' | 'endDate'>;

/**
 * When a date ends (#1005): its end, or its start when it has no end. An end
 * before the start is moved up to the start, so a date never ends before it
 * begins. A date with no start has no end either, because it isn't scheduled.
 */
export function dateEnd(date: DateWindow & { startDate: Date }): Date;
export function dateEnd(date: DateWindow): Date | null;
export function dateEnd(date: DateWindow): Date | null {
  if (date.startDate === null) {
    return null;
  }

  const { startDate, endDate } = date;

  return endDate !== null && endDate.getTime() > startDate.getTime() ? endDate : startDate;
}

/**
 * Whether a date has passed at `now` (#1005): its {@link dateEnd} is at or
 * before `now`. A date with no start never passes. Event status and the vote
 * and confirm checks share this rule; {@link dateNotPassedWhere} is its query form.
 */
export function hasDatePassed(date: DateWindow, now: Date): boolean {
  const end = dateEnd(date);

  return end !== null && end.getTime() <= now.getTime();
}

/**
 * {@link hasDatePassed}'s query form (#1005): the negation, as a `where`, of a
 * date that has passed at `now`. It has a start, and its start or its end is
 * still ahead. Prisma can't call the helper, so the two must change together.
 */
export function dateNotPassedWhere(now: Date): Prisma.EventOccurrenceWhereInput {
  return {
    startDate: { not: null },
    OR: [{ startDate: { gt: now } }, { endDate: { gt: now } }],
  };
}
