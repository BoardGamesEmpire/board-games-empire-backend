import type { PluginRequestedPermissions, PluginRequestedPermissionsReader } from '@bge/database';
import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from '../grants/consent-scope.map';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { revalidateStoredManifest, type StoredManifestRow } from './stored-manifest';

/** What this reader's `invalid` factory throws, so the catch below takes only its own failure. */
class StoredManifestInvalidError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

/**
 * The issues when validation produced them, the helper's own sentence
 * otherwise (a slug or version mismatch). The rejection already says the
 * stored manifest failed re-validation, so the detail does not repeat it.
 */
const describeInvalid = (detail: string, issues?: readonly ManifestIssue[]): string =>
  issues && issues.length > 0 ? issues.map((issue) => `${issue.path} ${issue.message}`).join('; ') : detail;

/**
 * The runtime's half of the snapshot's manifest bound (#577): the permissions
 * lib asks which permissions a plugin's ACTIVE manifest requests, and at which
 * decision scope, and this answers from the stored manifest under the same
 * never-trust contract as every other consumer (`revalidateStoredManifest`).
 * An invalid manifest is an answer, not a throw, so the snapshot can refuse
 * the ability with its own typed rejection.
 */
@Injectable()
export class StoredManifestRequestedPermissionsReader implements PluginRequestedPermissionsReader {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions) {}

  read(row: StoredManifestRow): PluginRequestedPermissions {
    try {
      const validated = revalidateStoredManifest(
        row,
        this.options,
        (_pluginSlug, detail, issues) => new StoredManifestInvalidError(describeInvalid(detail, issues)),
      );

      return {
        valid: true,
        requested: validated.permissionChecks.map((check) => ({
          slug: check.canonicalSlug,
          scopeType: CONSENT_SCOPE_TO_GRANT_SCOPE[check.consentScope],
        })),
      };
    } catch (error) {
      if (error instanceof StoredManifestInvalidError) {
        return { valid: false, detail: error.detail };
      }

      throw error;
    }
  }
}
