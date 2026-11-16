import { PluginScope, type PluginActiveManifest, type PluginConfigVerdict } from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { PluginConfigSchemaUnusableError } from '../config/config-schema.errors';
import type { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from '../grants/consent-scope.map';
import { MANIFEST_SCOPE_TO_PRISMA } from '../install/manifest-enum.maps';
import { isPlainJsonObject } from '../is-plain-json-object';

/**
 * The runtime's half of the dormancy rule and the manifest bound (#577,
 * #1151): what `@bge/database` needs from one re-validated active manifest.
 * Built here because only the runtime can re-validate a manifest and compile
 * its config schema; the readers that consume it cannot import the runtime.
 *
 * `judgeConfig` establishes that the schema is usable before it looks at the
 * document, so an unusable schema answers `'schema-unusable'` whatever the
 * document is: it says nothing about the document, and the rule reads it as
 * `unavailable`, which outranks `needs_configuration`.
 */
export function activeManifestOf(
  validated: PluginManifestValidationResult,
  configSchema: PluginConfigSchemaService,
): PluginActiveManifest {
  const { manifest } = validated;
  const target = { slug: manifest.slug, version: manifest.version, schema: manifest.config.schema };

  return {
    requested: validated.permissionChecks.map((check) => ({
      slug: check.canonicalSlug,
      scopeType: CONSENT_SCOPE_TO_GRANT_SCOPE[check.consentScope],
    })),
    householdSurface: MANIFEST_SCOPE_TO_PRISMA[manifest.scope] !== PluginScope.Server,
    judgeConfig(document: unknown): PluginConfigVerdict {
      try {
        configSchema.assertUsable(target);

        if (!isPlainJsonObject(document)) {
          return 'rejected';
        }

        return configSchema.validate({ ...target, config: document }).length === 0 ? 'conforms' : 'rejected';
      } catch (error) {
        if (error instanceof PluginConfigSchemaUnusableError) {
          return 'schema-unusable';
        }

        throw error;
      }
    },
  };
}
