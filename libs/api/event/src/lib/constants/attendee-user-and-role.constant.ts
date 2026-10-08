import { Prisma } from '@bge/database';

/**
 * An attendee's user, by name and avatar, and their role on the event, as
 * every route that serves attendees embeds them.
 *
 * One constant for the event detail and the attendee routes, so a field
 * added to or dropped from the user here reaches both, rather than leaving
 * the two serving different data about the same people.
 */
export const ATTENDEE_USER_AND_ROLE_INCLUDE = {
  user: {
    select: {
      id: true,
      username: true,
      profile: {
        select: {
          avatarUrl: true,
          displayName: true,
        },
      },
    },
  },

  role: {
    include: {
      role: {
        select: { id: true, name: true },
      },
    },
  },
} as const satisfies Prisma.EventAttendeeInclude;
