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

/** A permission request with the manifest's optional `consentScope` defaulted ('server' per #59). */
export type NormalizedPermissionRequest = Omit<PluginPermissionRequest, 'consentScope'> & {
  readonly consentScope: PluginConsentScopeValue;
};

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
  readonly externalPermissionChecks: readonly string[];
  readonly warnings: readonly ManifestWarning[];
}
