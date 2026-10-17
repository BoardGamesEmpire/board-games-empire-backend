import { Prisma } from '@bge/database';

/**
 * The rows nobody has removed. A removed attendee, or a game taken off an
 * attendee's list, keeps its row so the nominations and votes that name it
 * keep their history (#551). Every read that lists attendees or list entries,
 * or counts them, filters on this, so a removal reads as one everywhere.
 */
export const NOT_REMOVED = { removedAt: null } as const satisfies Prisma.EventAttendeeWhereInput &
  Prisma.EventAttendeeGameListWhereInput;
