import type { PluginGrantScope } from '../client';

/**
 * Injection token for the {@link PluginActiveManifestReader}. The plugin
 * runtime provides it; the permissions lib's snapshot read and the permission
 * catalog inject it for the manifest bound (#577), and the dormancy rule takes
 * what it answers (#1151). Shared from here for the reason
 * `SERVER_SCOPE_SENTINEL` is: the reader side cannot import the runtime, and
 * the runtime stays off the permissions lib (#409).
 */
export const PLUGIN_ACTIVE_MANIFEST_READER = Symbol('PLUGIN_ACTIVE_MANIFEST_READER');

/** One permission the active manifest requests, at the decision scope its consent scope maps to. */
export interface PluginRequestedPermission {
  /** The canonical slug, as grant rows carry it. */
  readonly slug: string;
  readonly scopeType: PluginGrantScope;
}

/**
 * How the active manifest's `config.schema` judges one document (#1151):
 * it conforms, the schema rejects it, or the schema itself cannot be used, in
 * which case nothing is learned about the document.
 */
export type PluginConfigVerdict = 'conforms' | 'rejected' | 'schema-unusable';

/**
 * What the dormancy rule and the manifest bound need from one re-validated
 * active manifest (#577, #1151). The runtime builds it, because only the
 * runtime can re-validate a manifest and compile its schema; it is described
 * here because the readers that consume it cannot import the runtime.
 */
export interface PluginActiveManifest {
  readonly requested: readonly PluginRequestedPermission[];
  /** False when the manifest's scope is `server`: no household can hold a unit enablement under it. */
  readonly householdSurface: boolean;
  /**
   * Judges a document against the manifest's `config.schema`. A schema that
   * cannot be used is `'schema-unusable'` whatever the document is; otherwise
   * a document that is not a plain object is `'rejected'`, and so is one the
   * schema's validator cannot get through (a document nested deeper than a
   * recursive schema can follow). Neither the document nor an unusable schema
   * makes it throw, since both are answers, and every read of the unit asks.
   */
  judgeConfig(document: unknown): PluginConfigVerdict;
}

/** What the reader answers for one plugin row: the active manifest, or why its stored JSON cannot be read. */
export type PluginActiveManifestReading =
  | { readonly valid: true; readonly manifest: PluginActiveManifest }
  | { readonly valid: false; readonly detail: string };

/**
 * Reads a plugin's ACTIVE manifest, re-validating the stored JSON rather than
 * trusting it (#577). A consent decision confers only while the active
 * manifest requests that permission at that scope, and a unit's dormancy is
 * worked out from the same manifest (#1151).
 */
export interface PluginActiveManifestReader {
  read(row: {
    readonly slug: string;
    readonly version: string;
    readonly manifestJson: unknown;
  }): PluginActiveManifestReading;
}

/**
 * The manifest bound (#577): whether the active manifest, as `requested`
 * lists it, requests a decision's permission at that decision's scope. Shared
 * by the plugin ability read, the permission catalog's count of the consent
 * decisions an edit affects (#772) and the update comparator's risk check
 * (#1152), so none of them can disagree.
 */
export function requestedByManifest(
  requested: readonly PluginRequestedPermission[],
): (decision: { readonly scopeType: PluginGrantScope; readonly permissionSlug: string }) => boolean {
  const keys = new Set(requested.map(({ slug, scopeType }) => `${scopeType}|${slug}`));

  return ({ scopeType, permissionSlug }) => keys.has(`${scopeType}|${permissionSlug}`);
}
