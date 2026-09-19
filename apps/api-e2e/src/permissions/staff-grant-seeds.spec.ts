import { Action, ResourceType, RiskLevel, SystemRole } from '@bge/database';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * What #244 changed, asserted against the SEEDED rows rather than the catalog
 * the unit specs read. `libs/database/src/lib/catalog/known-catalog-defects.spec.ts`
 * proves the shipped catalog holds no inert staff edge, and
 * `ability.factory.spec.ts` proves the composed Admin role reaches a household
 * it is no member of. Neither sees the reconciler: this suite is the join, and
 * a seed that wrote something other than what the catalog declares fails here
 * instead of surfacing as a 403 — or, worse, as an unfiltered query — inside
 * another suite.
 *
 * The `permissions`/`roles`/`role_permissions` tables are on the e2e sweep's
 * preserved list, so these are the same rows every other suite runs against.
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

  const permission = (slug: string) => db.client.permission.findUnique({ where: { slug } });

  const roleSlugs = async (roleName: SystemRole): Promise<string[]> => {
    const role = await db.client.role.findUniqueOrThrow({
      where: { name: roleName },
      select: { permissions: { select: { permission: { select: { slug: true } } } } },
    });

    return role.permissions.map((row) => row.permission.slug);
  };

  it('has retired the staff wildcard entirely', async () => {
    // Not merely unassigned — gone. It was an unconditioned `manage` on 'all',
    // which made Admin and Moderator each functionally Owner, and the prune
    // policy (#235) deletes a System-owned row the manifest stops listing.
    await expect(permission('manage:content:moderate')).resolves.toBeNull();

    for (const roleName of [SystemRole.Admin, SystemRole.Moderator]) {
      await expect(roleSlugs(roleName)).resolves.not.toContain('manage:content:moderate');
    }
  });

  it('leaves `manage` on the wildcard subject to Owner alone', async () => {
    const wildcards = await db.client.permission.findMany({
      where: { subject: 'all' },
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
      ['update:household_role:transfer-ownership:administer', Action.update, ResourceType.HouseholdRole],
      ['delete:game_play_session:moderate', Action.delete, ResourceType.GamePlaySession],
    ] as const;

    for (const [slug, action, subject] of floor) {
      await expect(permission(slug)).resolves.toMatchObject({
        action,
        subject,
        conditions: {},
        riskLevel: RiskLevel.Critical,
      });
    }
  });

  it('reaches Admin with the whole floor, and Moderator with the moderation half only', async () => {
    const admin = await roleSlugs(SystemRole.Admin);
    const moderator = await roleSlugs(SystemRole.Moderator);

    expect(admin).toEqual(
      expect.arrayContaining([
        'manage:household_member:administer',
        'delete:household:administer',
        'update:household_role:transfer-ownership:administer',
        'delete:game_play_session:moderate',
      ]),
    );

    expect(moderator).toContain('delete:game_play_session:moderate');
    // Moderation is not administration: removing content is not reassigning
    // ownership or deleting a household.
    expect(moderator).not.toContain('manage:household_member:administer');
    expect(moderator).not.toContain('delete:household:administer');
    expect(moderator).not.toContain('update:household_role:transfer-ownership:administer');
  });

  it('holds no grant Admin cannot render, which is what enumerating the list bought', async () => {
    // The 77 dropped edges were all templated on `{{ householdId }}` or
    // `{{ eventId }}`. Asserting the property rather than the list: any new
    // household- or event-templated slug reaching Admin fails here, whatever
    // it is called.
    const role = await db.client.role.findUniqueOrThrow({
      where: { name: SystemRole.Admin },
      select: { permissions: { select: { permission: { select: { slug: true, conditions: true } } } } },
    });

    const unrenderable = role.permissions
      .map(({ permission: { slug, conditions } }) => ({ slug, rendered: JSON.stringify(conditions ?? {}) }))
      .filter(({ rendered }) => rendered.includes('{{ householdId }}') || rendered.includes('{{ eventId }}'))
      .map(({ slug }) => slug)
      .sort();

    expect(unrenderable).toEqual([]);
  });

  it('keeps Admin a proper subset of the catalogue, not a derivation of it', async () => {
    const total = await db.client.permission.count();
    const admin = await roleSlugs(SystemRole.Admin);

    // The retired derivation was `every slug except manage:all`. Anything at
    // or above that count means it came back.
    expect(admin.length).toBeLessThan(total - 1);
  });
});
