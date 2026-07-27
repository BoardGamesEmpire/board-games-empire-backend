import { z } from 'zod';
import type { PluginConsentScopeValue } from './constants.js';
import type { ManifestWarning } from './errors.js';
import {
  pluginFeatureDeclarationSchema,
  pluginManifestSchema,
  pluginPermissionRequestSchema,
  pluginScheduleSchema,
  pluginTopicDeclarationSchema,
  pluginUpdateCheckSchema,
} from './manifest.schema.js';

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginFeatureDeclaration = z.infer<typeof pluginFeatureDeclarationSchema>;
export type PluginPermissionRequest = z.infer<typeof pluginPermissionRequestSchema>;
export type PluginTopicDeclaration = z.infer<typeof pluginTopicDeclarationSchema>;
export type PluginUpdateCheck = z.infer<typeof pluginUpdateCheckSchema>;
export type PluginSchedule = z.infer<typeof pluginScheduleSchema>;

/** Whether a check targets the plugin's own declared catalog or the core vocabulary. */
export type PermissionCheckOrigin = 'plugin' | 'core';

/**
 * A permission request with the manifest's optional `consentScope` defaulted
 * ('server' per #59) and its routing resolved: `origin` is 'plugin' when
 * the slug appears in `permissions.declares` (bare form), 'core' otherwise;
 * `canonicalSlug` is the at-rest form — the generated `plugin|<slug>|<bare>`
 * envelope for own checks, the slug as written for core checks. Grants,
 * `PluginPermission` rows, and lifecycle payloads carry `canonicalSlug`.
 */
export type NormalizedPermissionRequest = Omit<PluginPermissionRequest, 'consentScope'> & {
  readonly consentScope: PluginConsentScopeValue;
  readonly origin: PermissionCheckOrigin;
  readonly canonicalSlug: string;
};

/** One `declares[]` entry with its generated canonical form. */
export interface DeclaredPluginPermission {
  readonly bareSlug: string;
  readonly canonicalSlug: string;
}

/**
 * Successful validation output. `externalPermissionChecks` are the
 * `checks[].slug` entries outside the plugin's own namespace — their shape
 * is validated here, their EXISTENCE in the `Permission` table is an install
 * pipeline step (#59 validation step 3, DB half) that Phase C owns. Handing
 * the partition to the pipeline keeps this lib database-free.
 */
export interface PluginManifestValidationResult {
  readonly manifest: PluginManifest;
  readonly permissionChecks: readonly NormalizedPermissionRequest[];
  /** Every `declares[]` entry expanded to canonical form — the install pipeline's `PluginPermission` seed input. */
  readonly declaredPermissions: readonly DeclaredPluginPermission[];
  readonly externalPermissionChecks: readonly string[];
  readonly warnings: readonly ManifestWarning[];
}
