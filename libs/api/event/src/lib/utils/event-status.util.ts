import { EventStatus, OccurrenceStatus, type Event, type EventOccurrence } from '@bge/database';

/** The columns of a date the event's status is worked out from. */
export type EventStatusDate = Pick<EventOccurrence, 'status' | 'startDate' | 'endDate'>;

/** Selects {@link EventStatusDate} from an occurrence read. */
export const EVENT_STATUS_DATE_SELECT = { status: true, startDate: true, endDate: true } as const;

/** An event as every response serves it: the row plus its worked-out status. */
export type EventWithStatus = Event & { status: EventStatus };

/**
 * The status an event response carries, worked out on read and never stored
 * (#795). The host's decisions come first: archived, then cancelled. Without
 * either, the status comes from the event's window, which runs from the
 * earliest start to the latest end of its Confirmed dates. Only Confirmed
 * dates with a start count. A date without an end ends when it starts, and an
 * end before its start is clamped up to the start.
 *
 * - No counted date: Planning.
 * - Before the window: Scheduled.
 * - Inside it: Ongoing, between the days of a multi-day event too.
 * - After it: Completed.
 */
export function deriveEventStatus(
  event: Pick<Event, 'cancelledAt' | 'archivedAt'>,
  dates: readonly EventStatusDate[],
  now: Date,
): EventStatus {
  if (event.archivedAt !== null) {
    return EventStatus.Archived;
  }

  if (event.cancelledAt !== null) {
    return EventStatus.Cancelled;
  }

  let earliestStart: number | null = null;
  let latestEnd: number | null = null;

  for (const { status, startDate, endDate } of dates) {
    if (status !== OccurrenceStatus.Confirmed || startDate === null) {
      continue;
    }

    const start = startDate.getTime();
    const end = Math.max(start, endDate?.getTime() ?? start);

    earliestStart = earliestStart === null ? start : Math.min(earliestStart, start);
    latestEnd = latestEnd === null ? end : Math.max(latestEnd, end);
  }

  if (earliestStart === null || latestEnd === null) {
    return EventStatus.Planning;
  }

  const at = now.getTime();

  if (at < earliestStart) {
    return EventStatus.Scheduled;
  }

  return at < latestEnd ? EventStatus.Ongoing : EventStatus.Completed;
}

/** `event` with its {@link deriveEventStatus status} added. */
export function withEventStatus<T extends Pick<Event, 'cancelledAt' | 'archivedAt'>>(
  event: T,
  dates: readonly EventStatusDate[],
  now: Date,
): T & { status: EventStatus } {
  return { ...event, status: deriveEventStatus(event, dates, now) };
}
