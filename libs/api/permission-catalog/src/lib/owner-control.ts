import { SystemRole, type CatalogSnapshot, type PermissionSlug } from '@bge/database';
import { t } from '@bge/i18n';
import { UnprocessableEntityException } from '@nestjs/common';

/**
 * The one permission the Owner role holds, which every Owner power comes from
 * (#772), `update` on `Permission` included.
 */
export const OWNER_PERMISSION_SLUG = 'manage:all' satisfies PermissionSlug;

/**
 * Whether the Owner role, in `snapshot`, holds a live `manage:all`: the
 * permission is not retired, and the role's grant of it is not revoked.
 */
export function ownerKeepsControl(snapshot: CatalogSnapshot): boolean {
  const permission = snapshot.permissions.find(({ slug }) => slug === OWNER_PERMISSION_SLUG);

  return (
    permission !== undefined &&
    permission.retiredAt === null &&
    snapshot.rolePermissions.some(
      ({ roleName, permissionSlug, revokedAt }) =>
        roleName === SystemRole.Owner && permissionSlug === OWNER_PERMISSION_SLUG && revokedAt === null,
    )
  );
}

/**
 * Refuses an edit of the permission catalog that would leave the Owner role
 * without a live `manage:all` (#772), given the permission catalog as the
 * edit would leave it. Every edit of the permission catalog calls it under
 * the lock `lockCatalogEdits` takes: a permission retired, a grant revoked,
 * an entry handed back.
 *
 * Nothing else would catch it. A retired permission and a revoked grant drop
 * out of what the catalog guards judge, so no guard names them, and a start
 * leaves the Owner's edits alone. The Owner would lose every power,
 * `update` on `Permission` with them, and only SQL written by hand could undo
 * it. Conditions on `manage:all` need no check here: its resource type is
 * `all`, which has no Prisma model, so the probe refuses any condition on it.
 */
export function refuseOwnerLockout(after: CatalogSnapshot): void {
  if (!ownerKeepsControl(after)) {
    throw new UnprocessableEntityException({
      code: 'CATALOG_OWNER_LOCKOUT',
      message: t('errors.permission_catalog.owner_lockout'),
    });
  }
}
