import { SystemRole, type PrismaClient, type User } from '@bge/database';
import { makeUser } from '@bge/testing';
import { createActors } from './actors.js';
import { SET_AUTH_TOKEN_HEADER } from './signup.js';

/**
 * Unit coverage for the sentinel's concurrency contract — the one piece of
 * `createActors` whose failure mode only appears under interleaving, which
 * the e2e acceptance spec (sequential by nature) cannot pin. The fake below
 * mirrors the two behaviors that matter: signup creates a user row, and
 * "provisioning" grants Owner to the first human and User to everyone
 * after, exactly like `UserProvisioningService`. Everything else the
 * factories touch is answered minimally.
 */
interface FakeWorld {
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  signupCount(): number;
  ownerCount(): number;
  clearUsers(): void;
}

function createFakeWorld(
  options: {
    preexistingHumans?: number;
    firstHumanRoles?: readonly SystemRole[];
    laterHumanRoles?: readonly SystemRole[];
  } = {},
): FakeWorld {
  // What "provisioning" grants. Both branches are overridable so a spec can
  // arrange either wrong set: an Owner missing its base row, and — the case
  // the exact-set check actually exists for — an ordinary user that came back
  // holding the elevated set.
  const firstHumanRoles = options.firstHumanRoles ?? [SystemRole.User, SystemRole.Owner];
  const laterHumanRoles = options.laterHumanRoles ?? [SystemRole.User];
  const users = new Map<string, User>();
  const ownerIds = new Set<string>();
  let signups = 0;

  for (let i = 0; i < (options.preexistingHumans ?? 0); i += 1) {
    const preexisting = makeUser({ id: `usr_preexisting_${i}` });
    users.set(preexisting.id, preexisting);
  }

  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { name: string; email: string };
    signups += 1;

    const user = makeUser({ id: `usr_${signups}`, username: body.name, email: body.email });
    // First human becomes Owner — mirrors UserProvisioningService. The
    // check-then-set pair contains no await, so it is atomic per signup.
    if (users.size === 0) {
      ownerIds.add(user.id);
    }
    users.set(user.id, user);

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
      count: async () => users.size,
    },
    userRole: {
      findMany: async (args: { where: { userId: string } }) =>
        (ownerIds.has(args.where.userId) ? firstHumanRoles : laterHumanRoles).map((name) => ({
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
