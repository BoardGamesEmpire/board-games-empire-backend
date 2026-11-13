import type { Prisma, PrismaClient } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { APIError } from 'better-auth/api';

export const USER_REMOVAL_BLOCKED = 'USER_REMOVAL_BLOCKED';

/** better-auth's path for the admin route that removes a user. */
export const REMOVE_USER_PATH = '/admin/remove-user';

const MESSAGE: I18nPath = 'errors.auth.user_removal_blocked';

/** One foreign key that refuses a user's delete while a row on it still reaches the user. */
export interface UserRemovalBlocker {
  readonly table: string;
  readonly column: string;
  /** Matches a user with at least one such row. */
  readonly where: Prisma.UserWhereInput;
}

/** A user whose game collection holds an entry that matches `entry`. */
const collectionEntry = (entry: Prisma.GameCollectionWhereInput): Prisma.UserWhereInput => ({
  gameCollections: { some: entry },
});

/**
 * The data a user shares with other people: every foreign key that keeps
 * `ON DELETE RESTRICT` and that a user's delete reaches, so Postgres refuses to
 * delete a user while any of these rows names them (#1054). The user's private
 * data goes with them by `ON DELETE CASCADE`, and optional links are set to
 * NULL.
 *
 * Most point at `users` itself. The last three point at rows that cascade
 * from the user: their game collection, and the games from it they offered on
 * an event. A game that was scheduled or nominated there, on anyone's event,
 * is shared with that event.
 *
 * A household membership counts, although it is the user's own row, because
 * removing it would skip the rule that a last owner transfers ownership
 * before leaving. What happens to each kind of shared data is #1277's job.
 *
 * The list mirrors the database. An e2e test walks every table a user's
 * delete cascades to, reads the foreign keys into them that refuse a delete
 * from `pg_constraint`, and checks they are exactly these. A new required
 * relation with no delete rule fails that test until it is given one or is
 * added here.
 */
export const USER_REMOVAL_BLOCKERS: readonly UserRemovalBlocker[] = [
  { table: 'households', column: 'created_by_id', where: { households: { some: {} } } },
  { table: 'household_members', column: 'user_id', where: { householdMember: { some: {} } } },
  { table: 'events', column: 'created_by_id', where: { eventsCreated: { some: {} } } },
  { table: 'media_objects', column: 'owner_id', where: { mediaOwned: { some: {} } } },
  { table: 'media_objects', column: 'uploader_id', where: { mediaUploaded: { some: {} } } },
  { table: 'media_contributions', column: 'contributed_by_id', where: { mediaContributed: { some: {} } } },
  { table: 'loaned_games', column: 'lender_id', where: { loansGiven: { some: {} } } },
  { table: 'invites', column: 'inviter_id', where: { invitesSent: { some: {} } } },
  // Grants to themselves included. Their own grants cascade on `user_id`, but
  // this key's RESTRICT check runs before that cascade, because its constraint
  // is older, so Postgres refuses a self-grant too. Deleting a household gives
  // its owners such a grant (#1054).
  { table: 'user_permissions', column: 'granted_by_id', where: { permissionsGranted: { some: {} } } },
  { table: 'game_tags', column: 'added_by_id', where: { gameTags: { some: {} } } },
  {
    table: 'event_games',
    column: 'supplied_by_id',
    where: collectionEntry({ eventAttendeeGameLists: { some: { suppliedGames: { some: {} } } } }),
  },
  {
    table: 'event_game_nominations',
    column: 'supplied_from_id',
    where: collectionEntry({ eventAttendeeGameLists: { some: { nominations: { some: {} } } } }),
  },
  {
    table: 'excluded_games',
    column: 'game_collection_id',
    where: collectionEntry({ excludedFromHouseholds: { some: {} } }),
  },
];

export interface UserRemovalGateDeps {
  /** Whether any row in {@link USER_REMOVAL_BLOCKERS} reaches the user. */
  hasSharedData(userId: string): Promise<boolean>;
  /** Renders a refusal's catalog key. */
  render(key: I18nPath): string;
}

/** The slice of better-auth's endpoint context the gate reads. */
export interface UserRemovalGateContext {
  readonly path?: string;
}

export interface UserRemovalGate {
  /** `databaseHooks.account.delete.before`, run once per sign-in method of the user. */
  beforeAccountDelete(account: { readonly userId: string }, context: UserRemovalGateContext | null): Promise<void>;
  /** `databaseHooks.user.delete.before`. */
  beforeUserDelete(user: { readonly id: string }, context: UserRemovalGateContext | null): Promise<void>;
}

/**
 * The gate's reads, from the database.
 *
 * One count over every blocker. It ignores soft-delete flags on purpose:
 * Postgres refuses the delete for a deleted household or a former
 * membership's row just the same, as long as the row is there.
 */
export function userRemovalGateDeps(prisma: PrismaClient, render: (key: I18nPath) => string): UserRemovalGateDeps {
  const OR = USER_REMOVAL_BLOCKERS.map(({ where }) => where);

  return {
    async hasSharedData(userId) {
      return (await prisma.user.count({ where: { id: userId, OR } })) > 0;
    },
    render,
  };
}

/**
 * Refuses to remove a user who shares data with other people, with 409 and a
 * BGE code, before anything is deleted (#1054).
 *
 * better-auth's remove-user signs the user out, then deletes their sign-in
 * methods (its account rows), then the user row, outside any transaction.
 * Postgres refuses that last delete while shared data remains, which used to
 * leave the user with no way to sign in and everything else in place. The
 * account hook runs once per sign-in method, after the route has checked that
 * the actor may remove users and before any sign-in method is deleted, so the
 * refusal comes from there. The user hook refuses too, for a user with no
 * sign-in methods.
 *
 * The route signs the user out before these hooks run, so a refused removal
 * still ends the user's sessions. They can sign in again.
 *
 * The check and the deletes share no transaction, so shared data made in
 * between still has Postgres refuse the user row after the sign-in methods
 * are gone. Other people can make it as well as the user: an attendee can
 * nominate a game the user offered on an event. The window is the length of
 * the removal. #1277's own delete path closes it.
 *
 * Only remove-user is gated. The anonymous plugin deletes through the same
 * hooks, when an anonymous user asks to be deleted and once they sign up, and
 * an anonymous user has no shared data to protect.
 *
 * The message is rendered in the fallback locale, as the settings gates' are:
 * `/api/auth/*` runs ahead of Nest's i18n.
 */
export function createUserRemovalGate(deps: UserRemovalGateDeps): UserRemovalGate {
  const refuseIfShared = async (userId: string, context: UserRemovalGateContext | null): Promise<void> => {
    if (context?.path !== REMOVE_USER_PATH || !(await deps.hasSharedData(userId))) {
      return;
    }

    throw new APIError('CONFLICT', { code: USER_REMOVAL_BLOCKED, message: deps.render(MESSAGE) });
  };

  return {
    beforeAccountDelete: (account, context) => refuseIfShared(account.userId, context),
    beforeUserDelete: (user, context) => refuseIfShared(user.id, context),
  };
}
