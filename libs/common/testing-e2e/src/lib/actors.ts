import { SystemRole, type PrismaClient, type User } from '@bge/database';
import { randomUUID } from 'node:crypto';
import { createHouseholdWithMembers, type HouseholdFixture, type HouseholdWithMembersOptions } from './household.js';
import { pollUntil } from './poll.js';
import { performSignup, type SignupOptions, type SignupResult } from './signup.js';
import type { ActorDeps, SessionActor } from './types.js';

/**
 * The factory surface a spec works with. Every actor is a REAL user created
 * through the real signup wire path, holding a credential the running
 * server accepts — nothing here bypasses authentication, because the
 * authorization layer is the behavior e2e exists to exercise (#256).
 *
 * API-key actors are deliberately absent: deferred whole to #270 while the
 * key permission model is unbuilt (#254 D-11, broadened 2026-08-08).
 */
export interface Actors {
  /**
   * The server-scope Owner sentinel. `UserProvisioningService` grants the
   * FIRST human user in the database the base `SystemRole.User` role plus
   * `SystemRole.Owner` on top; elevation is additive (#410), never a swap.
   * The between-test sweep truncates users, so without a designated first
   * signup, whichever actor a test happened to create first would silently
   * become a superuser and authorization denials would stop being asserted
   * at all. Every other factory method ensures this sentinel exists before
   * creating its own user, so the Owner seat is always deterministically
   * absorbed.
   *
   * Memoized per test: the memo self-validates against the database, so an
   * `Actors` instance created in `beforeAll` stays correct across the
   * per-test truncate sweep (the sentinel is re-minted when its row is
   * gone).
   */
  owner(): Promise<SessionActor>;

  /**
   * A plain `SystemRole.User` actor — the base role alone, with nothing on
   * top. Implicitly ensures the Owner sentinel first. Fails loudly if
   * provisioning hands back any other role SET, which is how the sentinel is
   * caught masquerading as an ordinary user: it holds `User` as well, so only
   * an exact-set check separates the two.
   */
  user(options?: SignupOptions): Promise<SessionActor>;

  /**
   * A server-scope admin: a plain user additionally granted the
   * `SystemRole.Admin` catalog role (additive — abilities union across
   * `UserRole` rows, so the provisioned `User` role stays). This is the
   * BGE permission-catalog Admin that CASL consumes, NOT better-auth's
   * admin-plugin `user.role` column; the grant is arranged directly in the
   * database before the actor's first authenticated request, per the
   * ordering rule (#256 revised decision 5).
   */
  admin(options?: SignupOptions): Promise<SessionActor>;

  /**
   * A household with a role-scoped roster, arranged directly in the
   * database (see {@link createHouseholdWithMembers} for why not via the
   * endpoints, and for the ordering rule the caller must respect).
   */
  householdWithMembers(options: HouseholdWithMembersOptions): Promise<HouseholdFixture>;
}

/** How long a factory waits for the asynchronous provisioning listener. */
const PROVISIONING_TIMEOUT_MS = 15_000;

/**
 * Blocks until provisioning has written the actor's global roles, then hands
 * back every role name it granted, sorted.
 *
 * The barrier trips on the first non-empty read rather than on a read that
 * matches what the caller expects, and that is safe for a specific reason:
 * provisioning writes the whole set in one `createMany` inside one
 * transaction, so a visible row means a visible *set*. Keeping the barrier
 * dumb keeps two failures distinct — "provisioning never ran" times out here
 * with the message below, while "provisioning granted the wrong set" fails at
 * the caller, which can name both sets.
 */
async function waitForProvisionedRoleNames(
  prisma: PrismaClient,
  userId: string,
  username: string,
): Promise<readonly string[]> {
  return pollUntil(
    async () => {
      const userRoles = await prisma.userRole.findMany({
        where: { userId },
        select: { role: { select: { name: true } } },
      });

      return userRoles.length > 0 ? userRoles.map((userRole) => userRole.role.name).sort() : undefined;
    },
    {
      description:
        `user '${username}' (${userId}) to be provisioned — no UserRole row appeared within ` +
        `${PROVISIONING_TIMEOUT_MS}ms. The signup response returns before the asynchronous ` +
        `UserProvisioningListener runs; a timeout here means provisioning failed in the server ` +
        `(check its logs), not that the wait was too short.`,
      timeoutMs: PROVISIONING_TIMEOUT_MS,
    },
  );
}

async function loadUser(prisma: PrismaClient, userId: string): Promise<User> {
  return prisma.user.findUniqueOrThrow({ where: { id: userId } });
}

function toActor(user: User, signup: SignupResult): SessionActor {
  const headers = { Authorization: `Bearer ${signup.token}` } as const;

  return {
    user,
    credentials: { token: signup.token, headers },
    headers,
    password: signup.password,
  };
}

export function createActors(deps: ActorDeps): Actors {
  const { baseUrl, prisma } = deps;
  const fetchFn = deps.fetchFn ?? fetch;

  let sentinelPromise: Promise<SessionActor> | undefined;

  /**
   * Asserts the EXACT set provisioning granted, not merely that the expected
   * role is among them. Containment would be the smaller check and it is
   * wrong: elevation is additive (#410), so an Owner holds `User` too — and a
   * containment check for `User` would therefore accept the Owner sentinel as
   * an ordinary user, quietly retiring the ordering guard that is this
   * factory's whole reason for existing.
   */
  async function signUpProvisionedActor(
    options: SignupOptions,
    expectedRoles: readonly SystemRole[],
  ): Promise<SessionActor> {
    const signup = await performSignup(baseUrl, options, fetchFn);
    const granted = (await waitForProvisionedRoleNames(prisma, signup.userId, signup.username)).join(', ');
    const expected = [...expectedRoles].sort().join(', ');

    // Both sides are sorted, so string equality IS set equality here — and it
    // avoids an indexed walk whose in-range-ness depends on a preceding
    // length check that a later edit could reorder away.
    if (granted !== expected) {
      throw new Error(
        `User '${signup.username}' was provisioned with role(s) [${granted}], expected ` +
          `[${expected}]. Provisioning grants the base 'User' role to every human and adds ` +
          `'Owner' on top for the first one — a mismatch means either actor-creation ordering was ` +
          `violated (something created a user outside the factories, or the Owner sentinel was skipped), ` +
          `or provisioning's role set changed without this factory being taught the new shape.`,
      );
    }

    return toActor(await loadUser(prisma, signup.userId), signup);
  }

  async function mintSentinel(): Promise<SessionActor> {
    const humans = await prisma.user.count({ where: { isServiceAccount: false } });
    if (humans > 0) {
      throw new Error(
        `Cannot mint the Owner sentinel: ${humans} human user(s) already exist, so the Owner seat is ` +
          `taken (provisioning grants Owner only to the FIRST human). If a spec arranges users directly, ` +
          `it must create its actors through the factories first — or accept that no Owner actor is ` +
          `available in that test.`,
      );
    }

    return signUpProvisionedActor({ username: `e2e-owner-${randomUUID().slice(0, 8)}` }, [
      SystemRole.User,
      SystemRole.Owner,
    ]);
  }

  /**
   * Memoizes the IN-FLIGHT promise, not just the resolved actor: concurrent
   * factory calls (`Promise.all` of `user()`s) must share one mint, or every
   * caller past the first races the humans-count guard, signs up its own
   * would-be Owner, and whichever signup lands second provisions as User
   * while this factory expects Owner — a loud failure blaming the spec
   * author for a factory defect. A RESOLVED sentinel is revalidated against
   * the database so the memo survives the per-test truncate sweep; a
   * REJECTED mint is cleared so one failure (e.g. the seat-taken guard)
   * does not poison later tests.
   */
  async function owner(): Promise<SessionActor> {
    const current = sentinelPromise;

    if (current !== undefined) {
      let existing: SessionActor | undefined;
      try {
        existing = await current;
      } catch {
        // The awaited mint failed; its original caller already received the
        // rejection. This caller falls through to re-evaluate from scratch.
        existing = undefined;
      }

      if (existing !== undefined) {
        const row = await prisma.user.findUnique({ where: { id: existing.user.id }, select: { id: true } });
        if (row !== null) {
          return existing;
        }
        // The isolation sweep truncated the memoized sentinel — re-mint.
      }

      // Stale or failed. Clear only if no concurrent caller replaced the
      // memo while this one was awaiting, then re-enter: the retry either
      // adopts that newer in-flight mint or takes the fresh path below,
      // whose clear-to-assign window contains no await and so admits no
      // interleaved second mint.
      if (sentinelPromise === current) {
        sentinelPromise = undefined;
      }

      return owner();
    }

    sentinelPromise = mintSentinel();
    return sentinelPromise;
  }

  async function user(options: SignupOptions = {}): Promise<SessionActor> {
    await owner();
    return signUpProvisionedActor(options, [SystemRole.User]);
  }

  async function admin(options: SignupOptions = {}): Promise<SessionActor> {
    const actor = await user(options);

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { name: SystemRole.Admin },
      select: { id: true },
    });

    await prisma.userRole.create({ data: { userId: actor.user.id, roleId: adminRole.id } });

    return actor;
  }

  async function householdWithMembers(options: HouseholdWithMembersOptions): Promise<HouseholdFixture> {
    return createHouseholdWithMembers(prisma, options);
  }

  return { owner, user, admin, householdWithMembers };
}
