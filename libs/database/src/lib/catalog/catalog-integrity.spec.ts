import type { Prisma } from '../client';
import { Action, ResourceType, RiskLevel, SystemRole } from '../client';
import {
  assertEveryRoleSeeded,
  assertJsonConditions,
  assertRolePermissionCatalog,
  assertUniqueSlugs,
  assertValidSubjects,
} from './catalog-integrity';
import type { PermissionSeedDefinition, RoleSeedDefinition } from './seed-definitions';

const definition = (overrides: Partial<PermissionSeedDefinition> & Pick<PermissionSeedDefinition, 'slug'>) =>
  ({
    action: Action.read,
    subject: ResourceType.Game,
    riskLevel: RiskLevel.Low,
    reason: 'fixture',
    ...overrides,
  }) satisfies PermissionSeedDefinition;

describe('catalog integrity assertions', () => {
  describe('assertUniqueSlugs', () => {
    it('accepts a catalog whose slugs are all distinct', () => {
      expect(() =>
        assertUniqueSlugs([definition({ slug: 'read:game' }), definition({ slug: 'read:job' })]),
      ).not.toThrow();
    });

    it('names the duplicated slug', () => {
      const catalog = [
        definition({ slug: 'read:game' }),
        definition({ slug: 'read:job' }),
        definition({ slug: 'read:game' }),
      ];

      expect(() => assertUniqueSlugs(catalog)).toThrow(/read:game/);
    });
  });

  describe('assertValidSubjects', () => {
    it("accepts every ResourceType member and the literal 'all'", () => {
      const catalog = [
        definition({ slug: 'read:game', subject: ResourceType.Game }),
        definition({ slug: 'manage:all', subject: 'all' }),
      ];

      expect(() => assertValidSubjects(catalog)).not.toThrow();
    });

    it('names the slug and the offending subject', () => {
      const catalog = [definition({ slug: 'read:widget', subject: 'Widget' as ResourceType })];

      expect(() => assertValidSubjects(catalog)).toThrow(/read:widget.*Widget/);
    });
  });

  describe('assertJsonConditions', () => {
    it('accepts conditions built from strings, numbers, booleans, null, arrays and plain objects', () => {
      const catalog = [
        definition({
          slug: 'read:game',
          conditions: {
            deletedAt: null,
            visibility: { in: ['Public', 'Friends'] },
            OR: [{ minPlayers: 2 }, { isActive: true }],
          },
        }),
        definition({ slug: 'read:job' }),
      ];

      expect(() => assertJsonConditions(catalog)).not.toThrow();
    });

    it('names the slug and path of a Date, which the definition type itself admits', () => {
      const catalog = [definition({ slug: 'read:game', conditions: { OR: [{ createdAt: { gte: new Date(0) } }] } })];

      expect(() => assertJsonConditions(catalog)).toThrow(/read:game.*conditions\.OR\[0\]\.createdAt\.gte.*Date/);
    });

    it('names a bigint, which the column write would turn into a string of digits', () => {
      // The definition type refuses a bigint, so the fixture casts; the
      // `WhereInput` the builder accepts for a BigInt column does not.
      const conditions = { sizeBytes: BigInt(5) } as unknown as Prisma.InputJsonObject;

      expect(() => assertJsonConditions([definition({ slug: 'read:media_object', conditions })])).toThrow(
        /read:media_object.*conditions\.sizeBytes.*bigint/,
      );
    });

    it('names an undefined member, which JSON.stringify would drop', () => {
      const catalog = [definition({ slug: 'read:game', conditions: { deletedAt: undefined } })];

      expect(() => assertJsonConditions(catalog)).toThrow(/read:game.*conditions\.deletedAt.*undefined/);
    });

    it('names a hole in a sparse array, which JSON.stringify would write as null', () => {
      // An elided literal element fails the builder's type; a length-constructed
      // array does not, and `forEach` would have walked past the hole.
      const catalog = [definition({ slug: 'read:game', conditions: { OR: new Array<Prisma.InputJsonValue>(1) } })];

      expect(() => assertJsonConditions(catalog)).toThrow(/read:game.*conditions\.OR\[0\].*undefined/);
    });

    it('still names the path when the value has no constructor to describe', () => {
      const orphan = Object.create(Object.create(null) as object) as Prisma.InputJsonObject;
      const catalog = [definition({ slug: 'read:game', conditions: { deletedAt: orphan } })];

      expect(() => assertJsonConditions(catalog)).toThrow(/read:game.*conditions\.deletedAt.*object/);
    });
  });

  describe('assertRolePermissionCatalog', () => {
    const catalog = [definition({ slug: 'read:game' }), definition({ slug: 'read:job' })];

    it('accepts a map whose every key is a SystemRole and every slug is defined', () => {
      const roles = { [SystemRole.User]: ['read:game', 'read:job'], [SystemRole.Admin]: ['read:game'] };

      expect(() => assertRolePermissionCatalog(roles, catalog)).not.toThrow();
    });

    it('names the role and the slug that the permission catalog does not define', () => {
      const roles = { [SystemRole.User]: ['read:game', 'read:nope'] };

      expect(() => assertRolePermissionCatalog(roles, catalog)).toThrow(/read:nope.*User|User.*read:nope/);
    });

    it('names a role key that is not a SystemRole member', () => {
      const roles = { Wizard: ['read:game'] };

      expect(() => assertRolePermissionCatalog(roles, catalog)).toThrow(/Wizard/);
    });

    it('names a slug a role lists twice', () => {
      const roles = { [SystemRole.User]: ['read:game', 'read:game'] };

      expect(() => assertRolePermissionCatalog(roles, catalog)).toThrow(/read:game/);
    });
  });

  describe('assertEveryRoleSeeded', () => {
    const role = (name: SystemRole): RoleSeedDefinition => ({ name, description: 'fixture' });

    it('accepts a role catalog that seeds every SystemRole member once', () => {
      const roles = Object.values(SystemRole).map(role);

      expect(() => assertEveryRoleSeeded(roles)).not.toThrow();
    });

    it('names a SystemRole member the role catalog does not seed', () => {
      const roles = Object.values(SystemRole)
        .filter((name) => name !== SystemRole.EventSpectator)
        .map(role);

      expect(() => assertEveryRoleSeeded(roles)).toThrow(/EventSpectator/);
    });

    it('names a role the catalog seeds twice', () => {
      const roles = [...Object.values(SystemRole).map(role), role(SystemRole.User)];

      expect(() => assertEveryRoleSeeded(roles)).toThrow(/User/);
    });
  });
});
