import { ResourceType, SystemRole } from '../client';
import type { PermissionSeedDefinition, RoleSeedDefinition } from './seed-definitions';

/**
 * Structural integrity of the seeded catalogs, asserted where the catalogs
 * are DEFINED so a defect fails the first runtime import — a test, API boot,
 * or the seed's own import before it writes a row — rather than partway
 * through the seed run that happens to reach it. The typecheck does not
 * evaluate the module, so it cannot catch these. These were runtime throws
 * inside the seed's `assignPermissions` loop (#233 promoted them); the seed
 * keeps its own copies as defense, but nothing should reach them.
 *
 * Every function takes the catalog it checks as an argument rather than
 * importing the shipped one, so the negative cases can be exercised with
 * fixtures and the shipped catalog can be checked by the same code path.
 */

const VALID_SUBJECTS: ReadonlySet<string> = new Set<string>([...Object.values(ResourceType), 'all']);
const SYSTEM_ROLES: ReadonlySet<string> = new Set<string>(Object.values(SystemRole));

/** Every slug in the catalog appears exactly once. */
export function assertUniqueSlugs(catalog: readonly PermissionSeedDefinition[]): void {
  const seen = new Set<string>();
  for (const { slug } of catalog) {
    if (seen.has(slug)) {
      throw new Error(`Permission catalog defines slug '${slug}' more than once`);
    }

    seen.add(slug);
  }
}

/** Every subject is a `ResourceType` member or the literal `'all'`. */
export function assertValidSubjects(catalog: readonly PermissionSeedDefinition[]): void {
  for (const { slug, subject } of catalog) {
    if (!VALID_SUBJECTS.has(subject)) {
      throw new Error(`Permission '${slug}' has subject '${subject}', which is not a ResourceType member or 'all'`);
    }
  }
}

/**
 * Every key of the role→slugs map is a `SystemRole` member, and every slug it
 * lists is defined by the permission catalog exactly once per role.
 */
export function assertRolePermissionCatalog(
  rolePermissions: Readonly<Record<string, readonly string[]>>,
  catalog: readonly PermissionSeedDefinition[],
): void {
  const defined = new Set(catalog.map(({ slug }) => slug));

  for (const [roleName, slugs] of Object.entries(rolePermissions)) {
    if (!SYSTEM_ROLES.has(roleName)) {
      throw new Error(`Role-permission catalog names role '${roleName}', which is not a SystemRole member`);
    }

    const listed = new Set<string>();
    for (const slug of slugs) {
      if (!defined.has(slug)) {
        throw new Error(`Role '${roleName}' references slug '${slug}', which the permission catalog does not define`);
      }

      if (listed.has(slug)) {
        throw new Error(`Role '${roleName}' lists slug '${slug}' more than once`);
      }

      listed.add(slug);
    }
  }
}

/**
 * Every `SystemRole` member is seeded exactly once. `ROLE_PERMISSION_CATALOG`
 * and `ROLE_SCOPE` are keyed by `SystemRole`, so the compiler forces an entry
 * for a new enum member there — but the role catalog is a list, and a member
 * missing from it would reach the seed as a role to grant permissions to that
 * was never written.
 */
export function assertEveryRoleSeeded(roles: readonly RoleSeedDefinition[]): void {
  const seeded = new Set<string>();
  for (const { name } of roles) {
    if (seeded.has(name)) {
      throw new Error(`Role catalog seeds role '${name}' more than once`);
    }
    seeded.add(name);
  }

  for (const role of SYSTEM_ROLES) {
    if (!seeded.has(role)) {
      throw new Error(`Role catalog does not seed SystemRole member '${role}'`);
    }
  }
}
