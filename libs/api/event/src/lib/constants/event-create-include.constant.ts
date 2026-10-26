import { Prisma } from '@bge/database';
import { ATTENDEE_ORDER } from './attendee-order.constant';
import { OCCURRENCE_ORDER } from './occurrence-order.constant';

/**
 * Each attendee as `POST /events` returns them: with their role, in the order
 * they joined.
 */
export const EVENT_CREATE_ATTENDEE_INCLUDE = {
  role: {
    include: {
      role: { select: { id: true, name: true } },
    },
  },
} as const satisfies Prisma.EventAttendeeInclude;

/**
 * What `POST /events` returns with the event: its dates in order, its policy,
 * and its attendees with their roles.
 *
 * The create reads it back in the same statement. A replay (#252) reads the
 * same shape, but part by part, under each part's own read ceiling, as
 * `GET /events/:id` does: a creator who has lost read on their event since must
 * not get its current roster from a retry.
 */
export const EVENT_CREATE_INCLUDE = {
  occurrences: { orderBy: OCCURRENCE_ORDER },
  policy: true,
  attendees: { include: EVENT_CREATE_ATTENDEE_INCLUDE, orderBy: ATTENDEE_ORDER },
} as const satisfies Prisma.EventInclude;

export type CreatedEvent = Prisma.EventGetPayload<{ include: typeof EVENT_CREATE_INCLUDE }>;
