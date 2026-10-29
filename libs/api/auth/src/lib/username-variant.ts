import type { PrismaClient } from '@bge/database';
import { isProviderSignInPath, type ProviderPictureContext } from './provider-picture';

/**
 * The username a first sign-in gets (#912): `requested` when no one holds it,
 * else `requested-2`, `requested-3`, and so on, the least number whose variant
 * is free. Pure, and exact: `taken` is compared as whole usernames.
 */
export function firstFreeUsername(requested: string, taken: ReadonlySet<string>): string {
  if (!taken.has(requested)) {
    return requested;
  }

  let n = 2;
  while (taken.has(`${requested}-${n}`)) {
    n += 1;
  }

  return `${requested}-${n}`;
}

/**
 * Prisma hands `startsWith` to SQL `LIKE` as written, where `%` and `_` are
 * wildcards and a backslash escapes the next character. Escaping all three
 * makes the prefix match only itself: unescaped, `a\b-` would miss `a\b-2`,
 * and every retry would then pick the same taken variant.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export interface UsernameVariants {
  /**
   * `databaseHooks.user.create.before`: on a sign-in provider's path, swaps a
   * taken username for its first free variant. Nothing else changes: an email
   * sign-up whose username is taken is still refused by the unique index.
   */
  beforeUserCreate(
    user: { readonly name?: unknown },
    context: (ProviderPictureContext & object) | null,
  ): Promise<{ data: { name: string } } | undefined>;

  /**
   * The username the sign-in asked for, when `beforeUserCreate` replaced it,
   * else null. Read in `user.create.after` with the same endpoint context.
   */
  requestedUsername(context: object | null): string | null;
}

/**
 * Builds the username-variant pair for the user create hooks (#912).
 *
 * better-auth hands the same endpoint context object to `create.before` and
 * `create.after` of one sign-in, so a `WeakMap` keyed by it carries the
 * requested username from the first to the second without a column for it and
 * without leaking: an entry goes with its request.
 *
 * Two first sign-ins taking the same variant at the same moment race: the
 * second hits the unique index on `username` and better-auth redirects with
 * `unable_to_create_user`. That is accepted, since the user can sign in again
 * and then gets the next variant.
 */
export function createUsernameVariants(prisma: Pick<PrismaClient, 'user'>): UsernameVariants {
  const requestedBy = new WeakMap<object, string>();

  return {
    async beforeUserCreate(user, context) {
      if (context === null || !isProviderSignInPath(context)) {
        return undefined;
      }

      const requested = user.name;

      if (typeof requested !== 'string' || requested === '') {
        return undefined;
      }

      // Most first sign-ins ask for a free username, which the unique index
      // answers alone. The variant lookup below is a prefix LIKE that index
      // can't serve, so it runs only when the username is taken.
      const holder = await prisma.user.findUnique({ where: { username: requested }, select: { id: true } });

      if (holder === null) {
        return undefined;
      }

      // `<requested>-` variants only, so `j` does not read every username
      // starting with `j`.
      const rows = await prisma.user.findMany({
        where: { username: { startsWith: `${escapeLikePattern(requested)}-` } },
        select: { username: true },
      });
      const username = firstFreeUsername(requested, new Set([requested, ...rows.map((row) => row.username)]));

      requestedBy.set(context, requested);

      return { data: { name: username } };
    },

    requestedUsername(context) {
      return context === null ? null : (requestedBy.get(context) ?? null);
    },
  };
}
