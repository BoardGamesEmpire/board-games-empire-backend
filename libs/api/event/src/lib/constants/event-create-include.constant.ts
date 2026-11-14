import { Prisma } from '@bge/database';
import { POLICY_VIEW_INCLUDE, type EventPolicyView } from '../policy/policy-view';
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
  policy: { include: POLICY_VIEW_INCLUDE },
  attendees: { include: EVENT_CREATE_ATTENDEE_INCLUDE, orderBy: ATTENDEE_ORDER },
} as const satisfies Prisma.EventInclude;

/**
 * The create reads the policy with its lists embedded as join rows; what is
 * served is the `EventPolicyView` (#1268), the same shape every policy answer
 * has.
 */
export type CreatedEvent = Omit<Prisma.EventGetPayload<{ include: typeof EVENT_CREATE_INCLUDE }>, 'policy'> & {
  policy: EventPolicyView | null;
};
