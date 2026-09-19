import { Action, parseTemplate, ResourceType, RiskLevel, SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * What #244 changed, asserted against the SEEDED rows rather than the catalog
 * the unit specs read, and then against the running server rather than either.
 * `libs/database/src/lib/catalog/known-catalog-defects.spec.ts` proves the
 * shipped catalog holds no inert staff edge, and `ability.factory.spec.ts`
 * proves the composed Admin role reaches a household it is no member of.
 * Neither sees the reconciler: the first suite below is that join, and a seed
 * that wrote something other than what the catalog declares fails here instead
 * of surfacing as a 403 — or, worse, as an unfiltered query — inside another
 * suite.
 *
 * None of that sees the SERVICES, which is the gap the second suite closes and
 * the reason it exists. A grant can be declared, seeded, and composed into the
 * ability correctly and still authorize nothing, because the route behind it
 * refuses the actor on grounds CASL never sees.
 * `update:household_role:transfer-ownership:administer` shipped exactly that
 * way: `transferOwnership` requires the actor to be an owning MEMBER of the
 * household, so the "transfer ownership of any household as server staff"
 * floor never existed. Three specs asserted it was real; all three were reading
 * the catalog. Every floor slug with a route now has one test that drives it.
 *
 * The `permissions`/`roles`/`role_permissions` tables are on the e2e sweep's
 * preserved list, so these are the same rows every other suite runs against.
 * Actors are NOT preserved — the sweep truncates before every test — so the
 * behavioral suite arranges its own inside each test rather than in `beforeAll`.
 */
describe('staff grant seeds', () => {
  // Unused directly, but requiring it keeps this suite runnable only inside
  // the e2e harness (seeded DB), matching every sibling suite's contract.
  requireBaseUrl(process.env);

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  const permission = (slug: string) => db.client.permission.findUniqueOrThrow({ where: { slug } });

  const roleSlugs = async (roleName: SystemRole): Promise<string[]> => {
    const role = await db.client.role.findUniqueOrThrow({
      where: { name: roleName },
      select: { permissions: { select: { permission: { select: { slug: true } } } } },
    });

    return role.permissions.map((row) => row.permission.slug);
  };

  it('leaves no live staff wildcard, and no grant of it', async () => {
    // It was an unconditioned `manage` on 'all', which made Admin and Moderator
    // each functionally Owner. "Retired" is literal (#235): the reconciler
    // tombstones a System row the manifest stops listing by setting `retiredAt`,
    // and separately hard-deletes the grant edges. This harness seeds a fresh
    // container, so here the row is simply absent — but an already-seeded
    // database keeps the tombstone, and asserting absence would fail there on an
    // upgrade that is not a regression. What holds in both is that nothing LIVE
    // remains, which is the property authorization reads: every role → permission
    // hop in `permissions.service.ts` filters `retiredAt: null`.
    await expect(
      db.client.permission.count({ where: { slug: 'manage:content:moderate', retiredAt: null } }),
    ).resolves.toBe(0);

    for (const roleName of [SystemRole.Admin, SystemRole.Moderator]) {
      await expect(roleSlugs(roleName)).resolves.not.toContain('manage:content:moderate');
    }
  });

  it('leaves `manage` on the wildcard subject to Owner alone', async () => {
    // Live rows only, for the same reason: a tombstoned wildcard still carries
    // `subject: 'all'` and would show up here on an upgraded database.
    const wildcards = await db.client.permission.findMany({
      where: { subject: 'all', retiredAt: null },
      select: { slug: true, action: true },
    });

    expect(wildcards.map(({ slug }) => slug).sort()).toEqual(['manage:all', 'read:public_content']);

    const admin = await roleSlugs(SystemRole.Admin);
    const moderator = await roleSlugs(SystemRole.Moderator);

    expect(admin).not.toContain('manage:all');
    expect(moderator).not.toContain('manage:all');
    // The surviving wildcard is read-only, and staff keep it: cross-subject
    // read is the substance of a triage role, and it is why no read variant
    // is seeded below.
    expect(admin).toContain('read:public_content');
    expect(moderator).toContain('read:public_content');
  });

  it('seeds the staff floor unconditioned, which is the only shape that can reach a foreign household', async () => {
    // A global role arrives through the `roles` pass, which supplies neither
    // `householdId` nor `eventId`. A condition naming either would render to
    // `''` and match no row, so empty `conditions` is not laxity here — it is
    // the only rendering that authorizes anything at all.
    const floor = [
      ['manage:household_member:administer', Action.manage, ResourceType.HouseholdMember],
      ['delete:household:administer', Action.delete, ResourceType.Household],
      ['delete:game_play_session:moderate', Action.delete, ResourceType.GamePlaySession],
    ] as const;

    for (const [slug, action, subject] of floor) {
      const row = await permission(slug);

      // `toEqual` on a projection, NOT `toMatchObject` on the row.
      // `toMatchObject` matches recursively, so `{ conditions: {} }` is
      // satisfied by ANY object — including a fully templated blob. Adding a
      // condition to one of these would leave the assertion green while every
      // staff write silently became inert, which is the precise failure this
      // test names in its title.
      expect({ action: row.action, subject: row.subject, conditions: row.conditions, riskLevel: row.riskLevel }).toEqual(
        { action, subject, conditions: {}, riskLevel: RiskLevel.Critical },
      );
    }
  });

  it('reaches Admin with the whole floor, and Moderator with the moderation half only', async () => {
    const admin = await roleSlugs(SystemRole.Admin);
    const moderator = await roleSlugs(SystemRole.Moderator);

    expect(admin).toEqual(
      expect.arrayContaining([
        'manage:household_member:administer',
        'delete:household:administer',
        'delete:game_play_session:moderate',
      ]),
    );

    expect(moderator).toContain('delete:game_play_session:moderate');
    // Moderation is not administration: removing content is not deleting a
    // household or rewriting its roster.
    expect(moderator).not.toContain('manage:household_member:administer');
    expect(moderator).not.toContain('delete:household:administer');
  });

  it('holds no grant Admin cannot render, which is what enumerating the list bought', async () => {
    // The 77 dropped edges were all templated on `{{ householdId }}` or
    // `{{ eventId }}`. Asserting the property rather than the list: any new
    // household- or event-templated slug reaching Admin fails here, whatever
    // it is called.
    //
    // PARSED, not string-matched. `{{householdId}}`, `{{  householdId }}` and
    // the section form `{{#householdId}}` all render identically and none of
    // them contains the literal `{{ householdId }}`, so a substring test
    // reports a clean list for exactly the templates it exists to catch. This
    // is the same `parseTemplate` the unit guard uses, so the two cannot drift
    // on what counts as a variable.
    const role = await db.client.role.findUniqueOrThrow({
      where: { name: SystemRole.Admin },
      select: { permissions: { select: { permission: { select: { slug: true, conditions: true } } } } },
    });

    const unrenderable = role.permissions
      .map(({ permission: { slug, conditions } }) => ({ slug, ...parseTemplate(conditions) }))
      .filter(({ variables }) => variables.some((name) => name === 'householdId' || name === 'eventId'))
      .map(({ slug }) => slug)
      .sort();

    expect(unrenderable).toEqual([]);
  });

  it('binds none of Admin to a scope a global role does not have', async () => {
    // Stronger than the check above and the reason two slugs left the list
    // after review: a condition on a staff role is inert when it names a scope
    // variable, and REDUNDANT when it names `user.id`, because the household or
    // event role whose condition renders identically already carries the slug.
    // `create:household_role` duplicated `HouseholdOwner`/`HouseholdAdmin`;
    // `delete:event` duplicated `EventHost`, which an event's creator is seeded
    // as. Neither granted anything. A global role should hold no conditions at
    // all.
    const role = await db.client.role.findUniqueOrThrow({
      where: { name: SystemRole.Admin },
      select: { permissions: { select: { permission: { select: { slug: true, conditions: true } } } } },
    });

    const conditioned = role.permissions
      .filter(({ permission }) => Object.keys((permission.conditions as object | null) ?? {}).length > 0)
      .map(({ permission }) => permission.slug)
      .sort();

    expect(conditioned).toEqual([]);
  });

  it('keeps Admin a proper subset of the catalogue, not a derivation of it', async () => {
    const total = await db.client.permission.count({ where: { retiredAt: null } });
    const admin = await roleSlugs(SystemRole.Admin);

    // The retired derivation was `every slug except manage:all`. Anything at
    // or above that count means it came back — counted against live rows, since
    // tombstones would inflate the total and quietly loosen the bound.
    expect(admin.length).toBeLessThan(total - 1);
  });
});

/**
 * The floor, driven. Every assertion here is a status code from the running
 * server, because that is the only thing that distinguishes a grant which
 * authorizes an operation from one that merely passes the route guard.
 *
 * Each test pairs the Admin's result with a plain `User`'s against the same
 * fixture. Without the pair a green test proves nothing: these routes answer
 * 200 for any household member, so an assertion that the Admin succeeded is
 * only evidence of staff authority when an ordinary outsider is refused on the
 * identical request.
 */
describe('staff floor over the wire', () => {
  const baseUrl = requireBaseUrl(process.env);
  const HOUSEHOLDS_PATH = '/api/households';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * A household owned by somebody else, plus an Admin and a plain User who are
   * both strangers to it. Built per test: the isolation sweep truncates actors
   * before each one.
   */
  const foreignHousehold = async () => {
    const [owner, member, admin, outsider] = await Promise.all([
      actors.user(),
      actors.user(),
      actors.admin(),
      actors.user(),
    ]);

    const fixture = await actors.householdWithMembers({
      owner,
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });

    return { fixture, owner, admin, outsider, target: fixture.members[0] };
  };

  const membersPath = (householdId: string) => `${HOUSEHOLDS_PATH}/${householdId}/members`;

  it('lets staff read a roster they are no member of, and refuses an outsider the same read', async () => {
    const { fixture, admin, outsider } = await foreignHousehold();

    // TWO grants authorize this and the test cannot tell them apart, which is
    // worth stating rather than implying: `manage:household_member:administer`
    // is a CASL `manage` and matches every action, and `read:public_content` is
    // a `read` on 'all'. Removing the first leaves this passing — proven by
    // mutation. It is the role change below that isolates the administer grant.
    await request(baseUrl).get(membersPath(fixture.household.id)).set(admin.headers).expect(200);

    await request(baseUrl).get(membersPath(fixture.household.id)).set(outsider.headers).expect(403);
  });

  it("lets staff change a foreign member's role, and refuses an outsider the same write", async () => {
    const { fixture, admin, outsider, target } = await foreignHousehold();
    const path = `${membersPath(fixture.household.id)}/${target.member.id}/role`;
    const payload = { role: SystemRole.HouseholdAdmin };

    await request(baseUrl).patch(path).set(admin.headers).send(payload).expect(200);

    await expect(
      db.client.householdRole.findUniqueOrThrow({
        where: { householdMemberId: target.member.id },
        select: { role: { select: { name: true } } },
      }),
    ).resolves.toEqual({ role: { name: SystemRole.HouseholdAdmin } });

    await request(baseUrl).patch(path).set(outsider.headers).send(payload).expect(403);
  });

  it('lets staff soft-delete a foreign household, and refuses an outsider the same delete', async () => {
    const { fixture, admin, outsider } = await foreignHousehold();
    const path = `${HOUSEHOLDS_PATH}/${fixture.household.id}`;

    await request(baseUrl).delete(path).set(outsider.headers).expect(403);

    await request(baseUrl).delete(path).set(admin.headers).expect(200);

    // Soft, not hard: `delete:household:administer` is a `delete` action over a
    // row that survives with `deletedAt` set (#175 restores from here).
    await expect(
      db.client.household.findUniqueOrThrow({
        where: { id: fixture.household.id },
        select: { deletedAt: true },
      }),
    ).resolves.toEqual({ deletedAt: expect.any(Date) });
  });

  it('does NOT let staff transfer ownership of a household they are no member of', async () => {
    // The capability the floor briefly advertised, pinned as the absence it is.
    // A slug for it was seeded and removed: `transferOwnership` refuses any
    // actor who is not an OWNING MEMBER — a membership count before the
    // transaction, an owner-set check inside it — and `updateMemberRole` is no
    // way round that, because `HouseholdOwner` is excluded from
    // `ASSIGNABLE_HOUSEHOLD_ROLES` so every owner transition goes through this
    // one flow (#158). No route performs it for a stranger.
    //
    // 403 and not 404: with the slug gone the Admin holds no `update` on
    // `HouseholdRole`, so the route GATE refuses before the service is reached.
    // While the slug existed this same request got as far as the service and
    // came back 404 from the membership count — which is what made the grant
    // decorative and the gate's documented Owner-only property false at the
    // same time. Both layers are load-bearing; this asserts the outer one, and
    // the owner's 200 below is what keeps the assertion from passing merely
    // because the route is broken.
    const { fixture, owner, admin, target } = await foreignHousehold();
    const path = `${membersPath(fixture.household.id)}/${target.member.id}/transfer-ownership`;

    await request(baseUrl).post(path).set(admin.headers).expect(403);

    await request(baseUrl).post(path).set(owner.headers).expect(200);
  });
});
