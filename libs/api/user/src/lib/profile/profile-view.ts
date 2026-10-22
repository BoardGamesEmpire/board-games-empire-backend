import type { Prisma } from '@bge/database';

/**
 * The columns a profile read serves, and the username of the profile's
 * owner as its identity (#819).
 *
 * The favourite and disliked games, categories and mechanics, and the
 * preferred game length, are left out until #831 decides how each is served.
 */
export const PROFILE_SELECT = {
  userId: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  pronouns: true,
  location: true,
  preferredPlayerCount: true,
  willingToTeach: true,
  openToNewPlayers: true,
  houseRulesPreference: true,
  hostingCapability: true,
  dietaryRestrictions: true,
  accessibilityNeeds: true,
  reach: true,
  isSearchable: true,
  user: { select: { username: true } },
} as const satisfies Prisma.UserProfileSelect;

export type ProfileRow = Prisma.UserProfileGetPayload<{ select: typeof PROFILE_SELECT }>;

/**
 * Served to the profile's owner alone, whoever else can read the profile,
 * staff included (#819). Dietary restrictions and accessibility needs are
 * health details, and who else may see them is #830's. Reach and searchable
 * say who may read and find the profile, which is its owner's to know.
 */
export const OWNER_ONLY_PROFILE_FIELDS = [
  'dietaryRestrictions',
  'accessibilityNeeds',
  'reach',
  'isSearchable',
] as const;

type OwnerOnlyProfileField = (typeof OWNER_ONLY_PROFILE_FIELDS)[number];

/** A profile as a viewer is served it. The owner-only keys are present for its owner and absent for anyone else. */
export interface UserProfileView
  extends Omit<ProfileRow, 'user' | OwnerOnlyProfileField>, Partial<Pick<ProfileRow, OwnerOnlyProfileField>> {
  username: string;
}

/**
 * Shapes a profile row for the viewer. The owner-only keys are left out for
 * anyone but its owner, not set to null, so a client can tell a field it may
 * not see from one left blank.
 */
export function toProfileView({ user, ...profile }: ProfileRow, viewerIsOwner: boolean): UserProfileView {
  const view: UserProfileView = { ...profile, username: user.username };

  if (!viewerIsOwner) {
    for (const field of OWNER_ONLY_PROFILE_FIELDS) {
      delete view[field];
    }
  }

  return view;
}
