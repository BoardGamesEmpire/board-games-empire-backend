import { SystemRole, type CatalogSnapshot, type PermissionSlug } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

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
 * edit would leave it. Every edit that can take a power away calls it under
 * the lock `lockCatalogEdits` takes: a permission edited or retired, a grant
 * given or revoked.
 *
 * A hand back does not call it, and needs no call. It changes only who
 * manages the entry, which {@link ownerKeepsControl} does not read, and the
 * next start brings the entry in line with the permission catalog this
 * version ships, which gives the Owner role a live `manage:all`: a retired
 * `manage:all` handed back is revived, and a revoked Owner grant of it is
 * restored. A role's description confers nothing, so its edit does not call
 * it either.
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
    throw new CodedHttpException(
      Http.UnprocessableEntity,
      'CATALOG_OWNER_LOCKOUT',
      t('errors.permission_catalog.owner_lockout'),
    );
  }
}
