import { Action, RiskLevel, SystemRole } from '@bge/database';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The automated seed assertion deferred from #319: the four plugin admin
 * permissions exist post-seed with the locked risk tiers and role reach.
 * The `permissions`/`roles`/`role_permissions` tables are on the e2e
 * sweep's preserved list, so this asserts the same rows every suite runs
 * against — a drifted seed fails here instead of surfacing as a 403 deep
 * inside another suite.
 */
describe('plugin permission seeds', () => {
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

  it('seeds the four plugin admin permissions with the locked risk tiers', async () => {
    await expect(permission('manage:plugin')).resolves.toMatchObject({
      action: Action.manage,
      riskLevel: RiskLevel.Critical,
    });
    await expect(permission('read:plugin')).resolves.toMatchObject({
      action: Action.read,
      riskLevel: RiskLevel.Medium,
    });
    await expect(permission('manage:plugin:household')).resolves.toMatchObject({
      action: Action.manage,
      riskLevel: RiskLevel.Medium,
    });
    await expect(permission('read:plugin:household')).resolves.toMatchObject({
      action: Action.read,
      riskLevel: RiskLevel.Low,
    });
  });

  it('conditions the household pair on the CLS household', async () => {
    await expect(permission('manage:plugin:household')).resolves.toMatchObject({
      conditions: { householdId: '{{ householdId }}' },
    });
    await expect(permission('read:plugin:household')).resolves.toMatchObject({
      conditions: { householdId: '{{ householdId }}' },
    });
  });

  it('reaches Admin with the server pair (allPermsExceptManageAll) and Owner via manage:all', async () => {
    const admin = await roleSlugs(SystemRole.Admin);
    expect(admin).toEqual(expect.arrayContaining(['manage:plugin', 'read:plugin']));

    const owner = await roleSlugs(SystemRole.Owner);
    expect(owner).toContain('manage:all');
  });

  it('reaches the household admin roles with the household pair — and no further', async () => {
    for (const roleName of [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin]) {
      const slugs = await roleSlugs(roleName);
      expect(slugs).toEqual(expect.arrayContaining(['manage:plugin:household', 'read:plugin:household']));
      // Household authority never confers the SERVER pair.
      expect(slugs).not.toContain('manage:plugin');
      expect(slugs).not.toContain('read:plugin');
    }
  });

  it('keeps the server pair off the non-admin system roles', async () => {
    for (const roleName of [SystemRole.Moderator, SystemRole.User]) {
      const slugs = await roleSlugs(roleName);
      expect(slugs).not.toContain('manage:plugin');
    }
  });
});
