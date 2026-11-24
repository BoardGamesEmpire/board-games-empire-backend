import type { Prisma } from '@bge/database';

/**
 * An offered game that is live: not taken back, and its collection entry not
 * removed. An offer whose collection entry was removed stays in place,
 * untouched, and shows again in every read if the game is added back (#1221).
 * Every offered-games read and its total filters on this, and so does the
 * vote eligibility of only those offering games
 * (`VoteEligibility.PoolParticipants`).
 */
export const LIVE_OFFER = {
  removedAt: null,
  collection: { is: { deletedAt: null } },
} as const satisfies Prisma.EventAttendeeGameListWhereInput;
