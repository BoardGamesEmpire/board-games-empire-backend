import { EventParticipationStatus, Prisma } from '@bge/database';
import type { EventWithStatus } from './event-status.util';

/**
 * How the acting user attends an event, as an event read serves it (#867): which
 * attendee row is theirs, their RSVP, their role on the event by name, and the
 * row's RSVP date. `role` is `null` for an attendee with no role row.
 */
export interface EventAttendance {
  readonly attendeeId: string;
  readonly status: EventParticipationStatus;
  readonly role: string | null;
  readonly rsvpDate: Date | null;
}

/** Selects {@link EventAttendanceRow} from an attendee read. */
export const EVENT_ATTENDANCE_SELECT = {
  id: true,
  eventId: true,
  status: true,
  rsvpDate: true,
  role: { select: { role: { select: { name: true } } } },
} as const satisfies Prisma.EventAttendeeSelect;

export type EventAttendanceRow = Prisma.EventAttendeeGetPayload<{ select: typeof EVENT_ATTENDANCE_SELECT }>;

export function toEventAttendance(row: EventAttendanceRow): EventAttendance {
  return {
    attendeeId: row.id,
    status: row.status,
    role: row.role?.role.name ?? null,
    rsvpDate: row.rsvpDate,
  };
}

/** Builds the where for the acting user's own attendee rows on these events. */
export type OwnAttendeeWhere = (eventIds: readonly string[]) => Prisma.EventAttendeeWhereInput;

/**
 * The acting user's attendance on each of these events, keyed by event id. An
 * event with no entry is one they have no row on, or can't read theirs (#867).
 *
 * This is a top-level read for the ceiling's sake. `ownAttendeeWhere` carries
 * the `EventAttendee` read ceiling, and a deny-all ceiling is enforced only in
 * a top-level `where` (#559), so an `include` or `select` filter on the event
 * read would hand a key with no read on attendees every row it matched. The
 * event detail's embeds moved out for the same reason (#560).
 *
 * `ownAttendeeWhere` is `null` for an actor with no user, and no read is made:
 * `EventAttendee.userId` is nullable, so a where on `userId: null` would match
 * the rows of attendees with no account and hand the actor a stranger's
 * attendance.
 *
 * Takes the transaction client so the rows describe the snapshot of the page
 * they join (#372).
 */
export async function readEventAttendance(
  tx: Prisma.TransactionClient,
  eventIds: readonly string[],
  ownAttendeeWhere: OwnAttendeeWhere | null,
): Promise<ReadonlyMap<string, EventAttendance>> {
  if (ownAttendeeWhere === null || eventIds.length === 0) {
    return new Map();
  }

  const rows = await tx.eventAttendee.findMany({
    where: ownAttendeeWhere(eventIds),
    select: EVENT_ATTENDANCE_SELECT,
  });

  return new Map(rows.map((row) => [row.eventId, toEventAttendance(row)]));
}

export function withEventAttendance<T extends { id: string }>(
  rows: readonly T[],
  attendance: ReadonlyMap<string, EventAttendance>,
): (T & { attendance: EventAttendance | null })[] {
  return rows.map((row) => ({ ...row, attendance: attendance.get(row.id) ?? null }));
}

/** An event as a list serves it: the row, its status and the acting user's attendance. */
export type EventListRow = EventWithStatus & { attendance: EventAttendance | null };
