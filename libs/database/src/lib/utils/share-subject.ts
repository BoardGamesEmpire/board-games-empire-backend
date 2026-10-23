import type { MemberSharePolicy } from '../client';

/** A household member as the household share grants' role clause reads one. */
interface ShareRosterRow {
  readonly userId: string;
  readonly role: { readonly role: { readonly name: string } } | null;
}

/**
 * What the household share grants read off a household, beside the share: its
 * whole roster with each member's household role, and its member share
 * policy. A household with no settings row has no policy for a member's
 * grants to match.
 */
export interface HouseholdShareAuthority {
  readonly members: ShareRosterRow[];
  readonly settings: { readonly memberSharePolicy: MemberSharePolicy } | null;
}

/** The game a share is of, as the share grants read it. */
export interface SharedGameState {
  readonly deletedAt: Date | null;
  readonly createdById: string | null;
}

/**
 * A share into a household as the household share grants are asked about it
 * (#810): whether it opens in effect, the game it is of, and the household's
 * roster and member share policy. Sharing a game (`@bge/game`) and approving a
 * waiting share (`@bge/household`) ask about the same instance, so a grant
 * reads the sharer's standing the same way at both, as an invite's sending
 * and accepting do (`householdInviteSubject`).
 */
export function householdGameShareSubject(
  householdId: string,
  approvedAt: Date | null,
  game: SharedGameState,
  { members, settings }: HouseholdShareAuthority,
) {
  return {
    householdId,
    approvedAt,
    game: { deletedAt: game.deletedAt, createdById: game.createdById },
    household: { settings, members },
  };
}
