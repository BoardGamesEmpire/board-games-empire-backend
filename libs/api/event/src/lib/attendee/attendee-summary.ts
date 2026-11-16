import { Action, type Prisma, ResourceType } from '@bge/database';
import type { ScopeComposer } from '@bge/permissions';

/**
 * An attendee as a record that names them serves them (#1187, #1213): who they
 * are and their answer, read for a page's attendees under the attendee read
 * ceiling, never through another record's select. Their status says when they
 * answered Not attending, whose games can't be nominated. A guest added by
 * name has no user. The role isn't carried.
 */
export const ATTENDEE_SUMMARY_SELECT = {
  id: true,
  status: true,
  guestName: true,

  user: {
    select: {
      id: true,
      username: true,
      profile: { select: { displayName: true, avatarUrl: true } },
    },
  },
} as const satisfies Prisma.EventAttendeeSelect;

/** An attendee as {@link ATTENDEE_SUMMARY_SELECT} reads them. */
export type AttendeeSummary = Prisma.EventAttendeeGetPayload<{ select: typeof ATTENDEE_SUMMARY_SELECT }>;

/**
 * The attendees `ids` name, keyed by id, as far as the actor may read them: a
 * top-level read under the attendee read ceiling. In another record's select,
 * a key holding only read on that record would see the names and avatars it
 * can't read on the attendee routes (#404, #559).
 *
 * An id the actor can't read has no key. A removed attendee, or one who
 * answered Not attending, is still named: the record that points at them
 * outlives their leaving (#1213).
 *
 * `db` may be a write's transaction, so the read runs before its commit.
 */
export async function readableAttendees(
  db: Prisma.TransactionClient,
  scopeComposer: ScopeComposer,
  ids: Iterable<string>,
): Promise<ReadonlyMap<string, AttendeeSummary>> {
  const attendeeIds = [...new Set(ids)];

  if (attendeeIds.length === 0) {
    return new Map();
  }

  const attendees = await db.eventAttendee.findMany({
    where: scopeComposer.compose(ResourceType.EventAttendee, Action.read, { id: { in: attendeeIds } }),
    select: ATTENDEE_SUMMARY_SELECT,
  });

  return new Map(attendees.map((attendee) => [attendee.id, attendee]));
}
