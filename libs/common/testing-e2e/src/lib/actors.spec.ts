import { SystemRole, type PrismaClient, type User } from '@bge/database';
import { makeUser } from '@bge/testing';
import { createActors } from './actors.js';
import { SET_AUTH_TOKEN_HEADER, SIGN_IN_ANONYMOUS_PATH } from './signup.js';

/**
 * Unit coverage for the sentinel's concurrency contract — the one piece of
 * `createActors` whose failure mode only appears under interleaving, which
 * the e2e acceptance spec (sequential by nature) cannot pin. The fake below
 * mirrors the two behaviors that matter: signup creates a user row, and
 * "provisioning" grants Owner to a human signing up while no human holds a
 * role, and User to everyone after, exactly like `UserProvisioningService`
 * (#430). Everything else the factories touch is answered minimally, except
 * the user count: it evaluates the filter the factory sends, so the
 * sentinel's idea of a taken seat is checked against the fake provisioning's
 * rather than against itself.
 */
interface FakeWorld {
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  signupCount(): number;
  ownerCount(): number;
  clearUsers(): void;
}

/** Prisma's "at least one related row" filter, `{ some: {} }`, and nothing narrower. */
function isAnyRelatedFilter(expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return false;
  }

  const { some, ...rest } = expected as { some?: unknown };
  return (
    Object.keys(rest).length === 0 &&
    some !== null &&
    typeof some === 'object' &&
    Object.keys(some as object).length === 0
  );
}

/**
 * Answers the equality, `OR` and `{ some: {} }` subset of a Prisma `where` the
 * factories send, so a count honours the filter it was given rather than a
 * rule of the fake's own. A relation filter reads a boolean the caller
 * projects onto the row under the relation's name. Anything richer throws: a
 * silently wrong count is what this exists to expose.
 */
function matchesWhere(row: object, where: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR' && Array.isArray(expected)) {
      return expected.some((branch: Readonly<Record<string, unknown>>) => matchesWhere(row, branch));
    }

    if (isAnyRelatedFilter(expected)) {
      return (row as Record<string, unknown>)[key] === true;
    }

    if (expected !== null && typeof expected === 'object') {
      throw new Error(`fake: unsupported where clause on '${key}'`);
    }

    return (row as Record<string, unknown>)[key] === expected;
  });
}

function createFakeWorld(
  options: {
    preexistingHumans?: number;
    // Rows already in the database, for the cases a plain human cannot
    // arrange: a leftover guest, a NULL anonymous flag. Like the humans above,
    // they have been provisioned and hold a role.
    preexistingRows?: readonly Partial<User>[];
    // Human rows that exist but that provisioning has not reached yet: a
    // signup whose row committed and whose handler has not run (#430).
    unprovisionedHumans?: number;
    firstHumanRoles?: readonly SystemRole[];
    laterHumanRoles?: readonly SystemRole[];
    anonymousRoles?: readonly SystemRole[];
  } = {},
): FakeWorld {
  // What "provisioning" grants. Both branches are overridable so a spec can
  // arrange either wrong set: an Owner missing its base row, and — the case
  // the exact-set check actually exists for — an ordinary user that came back
  // holding the elevated set.
  const firstHumanRoles = options.firstHumanRoles ?? [SystemRole.User, SystemRole.Owner];
  const laterHumanRoles = options.laterHumanRoles ?? [SystemRole.User];
  // Mirrors provisioning's anonymous branch (#484): `AnonymousUser` alone, and
  // never the Owner seat. Overridable to arrange the one wrong set that
  // matters — `User` beside it.
  const anonymousRoles = options.anonymousRoles ?? [SystemRole.AnonymousUser];
  const users = new Map<string, User>();
  const ownerIds = new Set<string>();
  const anonymousIds = new Set<string>();
  // The users provisioning has run for, so the ones holding a role.
  const provisionedIds = new Set<string>();
  let signups = 0;
  let anonymousSignIns = 0;
  // The fake provisioning's own rule, written independently of the
  // factory's filter: the seat is taken once a person holds a role. Service
  // accounts and anonymous rows are not people, and a NULL anonymous flag is.
  const provisionedHumanCount = () =>
    [...users.values()].filter(
      (user) => provisionedIds.has(user.id) && user.isServiceAccount !== true && user.isAnonymous !== true,
    ).length;

  for (let i = 0; i < (options.preexistingHumans ?? 0); i += 1) {
    const preexisting = makeUser({ id: `usr_preexisting_${i}` });
    users.set(preexisting.id, preexisting);
    provisionedIds.add(preexisting.id);
  }

  (options.preexistingRows ?? []).forEach((overrides, i) => {
    const preexisting = makeUser({ id: `usr_preexisting_row_${i}`, ...overrides });
    users.set(preexisting.id, preexisting);
    provisionedIds.add(preexisting.id);
  });

  for (let i = 0; i < (options.unprovisionedHumans ?? 0); i += 1) {
    const unprovisioned = makeUser({ id: `usr_unprovisioned_${i}` });
    users.set(unprovisioned.id, unprovisioned);
  }

  const fetchFn: typeof fetch = async (url, init) => {
    if (String(url).endsWith(SIGN_IN_ANONYMOUS_PATH)) {
      anonymousSignIns += 1;

      const guest = makeUser({
        id: `usr_anon_${anonymousSignIns}`,
        username: 'Anonymous',
        email: `temp@anon-${anonymousSignIns}.com`,
        isAnonymous: true,
      });
      anonymousIds.add(guest.id);
      users.set(guest.id, guest);
      provisionedIds.add(guest.id);

      return new Response(JSON.stringify({ token: `tok_${guest.id}`, user: { id: guest.id } }), {
        status: 200,
        headers: { [SET_AUTH_TOKEN_HEADER]: `tok_${guest.id}` },
      });
    }

    const body = JSON.parse(String(init?.body)) as { name: string; email: string };
    signups += 1;

    const user = makeUser({ id: `usr_${signups}`, username: body.name, email: body.email });
    // Owner while no person holds a role — mirrors UserProvisioningService
    // (#430). The check-then-set pair contains no await, so it is atomic per
    // signup, which is what the election lock makes the real one.
    if (provisionedHumanCount() === 0) {
      ownerIds.add(user.id);
    }
    users.set(user.id, user);
    provisionedIds.add(user.id);

    return new Response(JSON.stringify({ token: `tok_${user.id}`, user: { id: user.id } }), {
      status: 200,
      headers: { [SET_AUTH_TOKEN_HEADER]: `tok_${user.id}` },
    });
  };

  const prisma = {
    user: {
      findUnique: async (args: { where: { id: string } }) => (users.has(args.where.id) ? { id: args.where.id } : null),
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        const user = users.get(args.where.id);
        if (user === undefined) {
          throw new Error(`fake: no user '${args.where.id}'`);
        }
        return user;
      },
      count: async (args: { where: Readonly<Record<string, unknown>> }) =>
        [...users.values()].filter((user) => matchesWhere({ ...user, roles: provisionedIds.has(user.id) }, args.where))
          .length,
    },
    userRole: {
      findMany: async (args: { where: { userId: string } }) =>
        (anonymousIds.has(args.where.userId)
          ? anonymousRoles
          : ownerIds.has(args.where.userId)
            ? firstHumanRoles
            : laterHumanRoles
        ).map((name) => ({
          role: { name },
        })),
      create: async () => ({ id: 'ur_fake' }),
    },
    role: {
      findUniqueOrThrow: async () => ({ id: 'role_fake' }),
    },
  };

  return {
    // Structural stand-in for the handful of delegate calls the factories
    // make; the cast is confined to this fixture. The REAL client's shapes
    // are exercised by apps/api-e2e/src/actors/actors.spec.ts.
    prisma: prisma as unknown as PrismaClient,
    fetchFn,
    signupCount: () => signups,
    ownerCount: () => ownerIds.size,
    clearUsers: () => {
      users.clear();
      ownerIds.clear();
      provisionedIds.clear();
    },
  };
}

describe('createActors — sentinel concurrency', () => {
  const baseUrl = 'http://api.e2e.invalid';

  it('concurrent factory calls share a single in-flight Owner mint', async () => {
    const world = createFakeWorld();
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    const [a, b] = await Promise.all([actors.user(), actors.user()]);

    expect(a.user.id).not.toBe(b.user.id);
    // Exactly one Owner minted, exactly three signups: sentinel + two users.
    expect(world.ownerCount()).toBe(1);
    expect(world.signupCount()).toBe(3);
  });

  it('sequential owner() calls reuse the memoized sentinel without a new signup', async () => {
    const world = createFakeWorld();
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    const first = await actors.owner();
    const second = await actors.owner();

    expect(second.user.id).toBe(first.user.id);
    expect(world.signupCount()).toBe(1);
  });

  it('a rejected mint does not poison later calls once the obstruction is gone', async () => {
    const world = createFakeWorld({ preexistingHumans: 1 });
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    await expect(actors.owner()).rejects.toThrow(/Owner seat is taken/);

    // The sweep-equivalent: the obstruction disappears between tests.
    world.clearUsers();

    const owner = await actors.owner();
    expect(world.ownerCount()).toBe(1);
    expect(owner.user.id).toBe('usr_1');
  });

  it('leaves the Owner seat open when the only row is an anonymous guest', async () => {
    // Provisioning never elects an anonymous row, so a guest already in the
    // database does not hold the seat. A sentinel count that took anonymous
    // rows for people would refuse to mint here.
    const world = createFakeWorld({ preexistingRows: [{ isAnonymous: true }] });
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    await actors.owner();

    expect(world.ownerCount()).toBe(1);
  });

  it('leaves the Owner seat open when the only human has not been provisioned yet', async () => {
    // A human row is not the seat; a human holding a role is (#430). A row
    // whose provisioning has not run cannot have been elected, so the sentinel
    // still takes the seat — which is exactly what provisioning will do.
    const world = createFakeWorld({ unprovisionedHumans: 1 });
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    await actors.owner();

    expect(world.ownerCount()).toBe(1);
  });

  it('counts a human whose anonymous flag is NULL as holding the Owner seat', async () => {
    // Provisioning counts a NULL flag as a person. A sentinel count that
    // matched only `false` would see an open seat, sign up, and get back a
    // plain User instead of the Owner it asked for.
    const world = createFakeWorld({ preexistingRows: [{ isAnonymous: null }] });
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    await expect(actors.owner()).rejects.toThrow(/Owner seat is taken/);
  });

  it('rejects an ordinary user that came back holding the elevated set', async () => {
    // The masquerade the exact-set check exists for, and the one a containment
    // check cannot see: an Owner holds `User` too, so `expected ⊆ granted`
    // accepts this actor and the sentinel gets handed out as an ordinary user
    // — retiring the first-human ordering guard without a single test going
    // red. Weakening the check in actors.ts to containment fails HERE.
    const world = createFakeWorld({ laterHumanRoles: [SystemRole.User, SystemRole.Owner] });
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    await expect(actors.user()).rejects.toThrow(/\[Owner, User\], expected \[User\]/);
  });

  it('rejects an Owner provisioned without its base User row', async () => {
    // The pre-#410 shape: `Owner` alone, with no independently-held base. A
    // containment check would accept this; the exact-set check must not,
    // because an Owner without `User` holds LESS than an ordinary user
    // outside `manage:all`.
    const world = createFakeWorld({ firstHumanRoles: [SystemRole.Owner] });
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    await expect(actors.owner()).rejects.toThrow(/\[Owner\], expected \[Owner, User\]/);
  });

  it('re-mints when the memoized sentinel was truncated out from under it', async () => {
    const world = createFakeWorld();
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    const before = await actors.owner();
    world.clearUsers();

    const after = await actors.owner();

    expect(after.user.id).not.toBe(before.user.id);
    expect(world.signupCount()).toBe(2);
  });
});

describe('createActors — anonymous', () => {
  const baseUrl = 'http://api.e2e.invalid';

  it('signs a guest in through the anonymous route once the Owner sentinel exists, with a credential and no password', async () => {
    const world = createFakeWorld();
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    const guest = await actors.anonymous();

    // The sentinel is minted first, as for every factory, so the Owner seat is
    // absorbed deterministically whatever a spec creates next.
    expect(world.ownerCount()).toBe(1);
    expect(guest.user.isAnonymous).toBe(true);
    expect(guest.headers).toEqual({ Authorization: `Bearer tok_${guest.user.id}` });
    expect(guest).not.toHaveProperty('password');
  });

  it('rejects a guest provisioned with User beside AnonymousUser', async () => {
    // The regression the exact-set check exists for here: `User` on an
    // anonymous row hands every anonymous session a signed-in user's authority,
    // and a containment check for `AnonymousUser` would accept it.
    const world = createFakeWorld({ anonymousRoles: [SystemRole.AnonymousUser, SystemRole.User] });
    const actors = createActors({ baseUrl, prisma: world.prisma, fetchFn: world.fetchFn });

    await expect(actors.anonymous()).rejects.toThrow(/\[AnonymousUser, User\], expected \[AnonymousUser\]/);
  });
});
