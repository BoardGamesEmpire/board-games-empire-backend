import { Prisma } from '@bge/database';
import { SHOWN_NAME_SELECT, shownName } from '../shown-name';

/** A household ban as the ban routes read it (#782). */
export const HOUSEHOLD_BAN_SELECT = {
  id: true,
  householdId: true,
  reason: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, ...SHOWN_NAME_SELECT } },
  bannedBy: { select: { id: true, ...SHOWN_NAME_SELECT } },
} as const satisfies Prisma.HouseholdBanSelect;

type HouseholdBanRow = Prisma.HouseholdBanGetPayload<{ select: typeof HOUSEHOLD_BAN_SELECT }>;

/** Someone a ban names, by id and as they are shown. */
interface BanParty {
  readonly id: string;
  readonly name: string;
}

/**
 * A household ban as its owners and admins see it (#782): who is banned, who
 * banned them and why. `bannedBy` is null once the user who banned
 * them is deleted; the ban stands.
 */
export interface HouseholdBanView {
  readonly id: string;
  readonly householdId: string;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly user: BanParty;
  readonly bannedBy: BanParty | null;
}

export function toHouseholdBanView(row: HouseholdBanRow): HouseholdBanView {
  const { user, bannedBy, ...ban } = row;

  return {
    ...ban,
    user: { id: user.id, name: shownName(user) },
    bannedBy: bannedBy === null ? null : { id: bannedBy.id, name: shownName(bannedBy) },
  };
}
