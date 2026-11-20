import type { PluginActiveManifestReader, PluginActiveManifestReading } from '@bge/database';
import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import { activeManifestOf } from './active-manifest';
import type { StoredManifestRow } from './stored-manifest';
import { revalidateStoredManifest } from './stored-manifest';

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
 * The runtime's side of the active-manifest port (#577, #1151): the
 * permissions lib and the permission catalog ask for a plugin's ACTIVE
 * manifest, for the permissions it requests and for what the dormancy rule
 * needs, and this answers from the stored manifest under the same never-trust
 * contract as every other consumer (`revalidateStoredManifest`). An invalid
 * manifest is an answer, not a throw, so the snapshot can refuse the ability
 * with its own typed rejection.
 */
@Injectable()
export class StoredActiveManifestReader implements PluginActiveManifestReader {
  constructor(
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
    private readonly configSchema: PluginConfigSchemaService,
  ) {}

  read(row: StoredManifestRow): PluginActiveManifestReading {
    try {
      const validated = revalidateStoredManifest(
        row,
        this.options,
        (_pluginSlug, detail, issues) => new StoredManifestInvalidError(describeInvalid(detail, issues)),
      );

      return { valid: true, manifest: activeManifestOf(validated, this.configSchema) };
    } catch (error) {
      if (error instanceof StoredManifestInvalidError) {
        return { valid: false, detail: error.detail };
      }

      throw error;
    }
  }
}
