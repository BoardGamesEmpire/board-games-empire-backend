import type { Permission, PermissionSeedDefinition, Role, RoleSeedDefinition } from '@bge/database';
import { PERMISSION_CATALOG, PrismaClient, ResourceType, ROLE_CATALOG, ROLE_PERMISSION_CATALOG } from '@bge/database';
import type { Logger } from '@nestjs/common';

/**
 * Writes the permission and role catalogs to the database.
 *
 * The catalog itself — `PERMISSION_CATALOG`, `ROLE_CATALOG`,
 * `ROLE_PERMISSION_CATALOG` — is data owned by `@bge/database` (#233), so it
 * can be imported, diffed, hashed and validated without executing this
 * function. This is the write side only, and it is deliberately naive:
 *
 * - **Seed-wins.** Every run overwrites `action`, `subject`, `fields`,
 *   `conditions`, `reason` and `riskLevel` from the catalog (#60 — the admin
 *   reclassification flow is out of scope, so the seed is the only writer).
 *   Provenance and reconciliation are #235.
 * - **Additive-only.** `assignPermissions` upserts `RolePermission` rows and
 *   never revokes one; removing a slug from a role's catalog list does not
 *   remove the grant (#232 defect 2, fixed by #235's prune policy).
 *
 * @todo refinements - these need work
 */
export async function rolesAndPermissionsSeed(prisma: PrismaClient, logger: Logger) {
  // ============================================
  // PERMISSIONS
  // ============================================
  logger.log('📋 Creating permissions...');

  // Widen from the `as const` tuple to the declared shape: entries without
  // `conditions`/`fields` are simply absent members here, not type errors.
  const permissionCatalog: readonly PermissionSeedDefinition[] = PERMISSION_CATALOG;

  const permissionsBySlug: Record<string, Permission> = {};
  for (const perm of permissionCatalog) {
    const created = await prisma.permission.upsert({
      where: { slug: perm.slug },
      update: {
        action: perm.action,
        subject: perm.subject,
        fields: [...(perm.fields ?? [])],
        conditions: perm.conditions ?? {},
        reason: perm.reason,
        riskLevel: perm.riskLevel,
      },
      create: {
        action: perm.action,
        subject: perm.subject,
        fields: [...(perm.fields ?? [])],
        conditions: perm.conditions ?? {},
        reason: perm.reason,
        riskLevel: perm.riskLevel,
        slug: perm.slug,
      },
    });
    permissionsBySlug[perm.slug] = created;
  }
  logger.log(`✅ Default permissions created.`);

  // ============================================
  // SYSTEM ROLES
  // ============================================
  logger.log('📋 Creating roles...');

  const roleCatalog: readonly RoleSeedDefinition[] = ROLE_CATALOG;

  const rolesByName: Record<string, Role> = {};
  for (const roleData of roleCatalog) {
    const created = await prisma.role.upsert({
      where: { name: roleData.name },
      update: { description: roleData.description, isSystem: true },
      create: { name: roleData.name, description: roleData.description, isSystem: true },
    });
    rolesByName[roleData.name] = created;
  }
  logger.log('✅ Roles created.');

  const resources = new Set<string>([...Object.values(ResourceType), 'all']);

  // Helper to map permissions to roles. The two throws below are defence
  // only: the catalog asserts both invariants at module scope, so a run that
  // reaches either has imported a catalog that failed to load.
  const assignPermissions = async (roleName: string, slugs: readonly string[]) => {
    const roleId: string = rolesByName[roleName].id;
    for (const slug of slugs) {
      const permission = permissionsBySlug[slug];
      if (!permission) {
        throw new Error(`Permission with slug ${slug} not found for role ${roleName}`);
      }

      if (!resources.has(permission.subject)) {
        throw new Error(`Permission subject ${permission.subject} is not a valid resource type for role ${roleName}`);
      }

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId,
          permissionId: permission.id,
        },
      });
    }
  };

  logger.log('📋 Assigning permissions to roles...');

  for (const [roleName, slugs] of Object.entries(ROLE_PERMISSION_CATALOG)) {
    await assignPermissions(roleName, slugs);
  }

  logger.log('✅ All permissions assigned.');
}
