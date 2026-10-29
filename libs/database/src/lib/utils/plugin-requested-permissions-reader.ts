import type { PluginGrantScope } from '../client';

/**
 * Injection token for the {@link PluginRequestedPermissionsReader}. The plugin
 * runtime provides it and the permissions lib's snapshot read injects it
 * (#577). Shared from here for the reason `SERVER_SCOPE_SENTINEL` is: the
 * reader side cannot import the runtime, and the runtime stays off the
 * permissions lib (#409).
 */
export const PLUGIN_REQUESTED_PERMISSIONS_READER = Symbol('PLUGIN_REQUESTED_PERMISSIONS_READER');

/** One permission the active manifest requests, at the decision scope its consent scope maps to. */
export interface PluginRequestedPermission {
  /** The canonical slug, as grant rows carry it. */
  readonly slug: string;
  readonly scopeType: PluginGrantScope;
}

export type PluginRequestedPermissions =
  | { readonly valid: true; readonly requested: readonly PluginRequestedPermission[] }
  | { readonly valid: false; readonly detail: string };

/**
 * Reads the requested permissions of a plugin's ACTIVE manifest, re-validating
 * the stored JSON rather than trusting it (#577). A consent decision confers
 * only while the active manifest requests that permission at that scope.
 */
export interface PluginRequestedPermissionsReader {
  read(row: {
    readonly slug: string;
    readonly version: string;
    readonly manifestJson: unknown;
  }): PluginRequestedPermissions;
}
