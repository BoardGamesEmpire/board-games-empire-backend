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
   * The server-scope Owner sentinel. `UserProvisioningService` grants
   * `SystemRole.Owner` to the FIRST human user in the database, and the
   * between-test sweep truncates users — so without a designated first
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
   * A plain `SystemRole.User` actor. Implicitly ensures the Owner sentinel
   * first. Fails loudly if provisioning hands back any other role — that
   * means the first-human-becomes-Owner ordering was violated.
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

async function waitForProvisionedRoleName(prisma: PrismaClient, userId: string, username: string): Promise<string> {
  return pollUntil(
    async () => {
      const userRole = await prisma.userRole.findFirst({
        where: { userId },
        select: { role: { select: { name: true } } },
      });

      return userRole?.role.name;
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

  async function signUpProvisionedActor(options: SignupOptions, expectedRole: SystemRole): Promise<SessionActor> {
    const signup = await performSignup(baseUrl, options, fetchFn);
    const roleName = await waitForProvisionedRoleName(prisma, signup.userId, signup.username);

    if (roleName !== expectedRole) {
      throw new Error(
        `User '${signup.username}' was provisioned with role '${roleName}', expected '${expectedRole}'. ` +
          `Provisioning grants Owner to the first human user and User to everyone after — an unexpected ` +
          `role means actor-creation ordering was violated (something created a user outside the factories, ` +
          `or the Owner sentinel was skipped).`,
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

    return signUpProvisionedActor({ username: `e2e-owner-${randomUUID().slice(0, 8)}` }, SystemRole.Owner);
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
    return signUpProvisionedActor(options, SystemRole.User);
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
