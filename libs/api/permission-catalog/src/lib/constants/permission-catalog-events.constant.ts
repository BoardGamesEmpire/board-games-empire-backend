/**
 * EventEmitter2 names for the Owner's edits to the permission catalog (#772).
 * Internal domain-event names, read by the audit listener; no webhook carries
 * them.
 */
export enum PermissionCatalogEvents {
  PermissionUpdated = 'permission_catalog.permission.updated',
}
