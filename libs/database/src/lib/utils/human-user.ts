import type { Prisma } from '../client';

/**
 * The users that are people: not the system's service principal, and not an
 * anonymous guest (#484). `isAnonymous` is nullable and a NULL is a person, so
 * it is matched explicitly; `isAnonymous: false` alone would drop those rows.
 *
 * Shared because two surfaces must agree on it and one cannot import the
 * other: provisioning elects the first person Owner by counting these rows,
 * and the e2e harness, which does not import the auth lib, counts the same
 * rows to know whether that seat is still open.
 */
export const HUMAN_USER_WHERE = {
  isServiceAccount: false,
  OR: [{ isAnonymous: false }, { isAnonymous: null }],
} satisfies Prisma.UserWhereInput;
