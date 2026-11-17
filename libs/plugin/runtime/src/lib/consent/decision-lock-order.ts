/**
 * Orders consent decisions by `permissionSlug` in code-unit order, not locale
 * order: every writer takes the decisions' rows in this order, so it is a lock
 * order every process must agree on (#1150, #1336). One comparator for every
 * consent act, so two writers cannot sort the same rows differently.
 */
export function byPermissionSlugCodeUnit(
  a: { readonly permissionSlug: string },
  b: { readonly permissionSlug: string },
): number {
  if (a.permissionSlug < b.permissionSlug) {
    return -1;
  }

  return a.permissionSlug > b.permissionSlug ? 1 : 0;
}
