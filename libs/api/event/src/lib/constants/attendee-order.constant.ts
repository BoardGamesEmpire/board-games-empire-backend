import { Prisma } from '@bge/database';

/**
 * How an event's attendees are ordered, everywhere they are listed: in the
 * order they joined.
 *
 * `id` completes the order because attendees added together, such as the
 * invitees an event is created with, can share a `createdAt`. Without it the
 * database is free to return those differently between requests, and the
 * event detail and `GET /events/:eventId/attendees` to disagree about them.
 */
export const ATTENDEE_ORDER = [
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.EventAttendeeOrderByWithRelationInput[];
