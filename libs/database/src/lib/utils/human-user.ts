import type { Prisma } from '../client';

/**
 * The users that are people: not the system's service principal, and not an
 * anonymous guest (#484). `isAnonymous` is nullable and a NULL is a person, so
 * it is matched explicitly; `isAnonymous: false` alone would drop those rows.
 */
const HUMAN_USER_WHERE = {
  isServiceAccount: false,
  OR: [{ isAnonymous: false }, { isAnonymous: null }],
} satisfies Prisma.UserWhereInput;

/**
 * The people provisioning has already run for. It writes a user's global roles
 * in one transaction, and every provisioned human holds at least one (`User`,
 * plus `Owner` for the first), so a role row is the mark it leaves.
 *
 * The Owner seat is taken once such a row exists (#430). The election cannot
 * count human rows instead: better-auth commits the user row before
 * provisioning runs, so two first signups can both be committed before either
 * handler looks, and a count then sees two humans and elects nobody.
 *
 * Shared because two surfaces must agree on it and one cannot import the
 * other: provisioning asks it to hold the election, and the e2e harness, which
 * does not import the auth lib, asks it to know whether the seat is still open.
 */
export const PROVISIONED_HUMAN_WHERE = {
  ...HUMAN_USER_WHERE,
  roles: { some: {} },
} satisfies Prisma.UserWhereInput;
