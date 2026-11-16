import { PluginScope, type PluginActiveManifest, type PluginConfigVerdict } from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { PluginConfigSchemaUnusableError, type PluginConfigIssue } from '../config/config-schema.errors';
import type { PluginConfigSchemaService, PluginConfigValidationInput } from '../config/plugin-config-schema.service';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from '../grants/consent-scope.map';
import { MANIFEST_SCOPE_TO_PRISMA } from '../install/manifest-enum.maps';
import { isPlainJsonObject } from '../is-plain-json-object';

/**
 * What the active config schema says about one document (#1151): the
 * violations, none when the document conforms. The one place the three steps
 * are written, so `judgeConfig` and the household switch-on gate cannot
 * judge a document differently.
 *
 * The schema's usability is established first and
 * `PluginConfigSchemaUnusableError` propagates, so an unusable schema answers
 * that whatever the document is. A document that is not a plain object
 * fails with one root issue before the schema is consulted: a Json column
 * admits arrays, `null` and scalars, and a permissive schema such as `{}`
 * would accept every one of them.
 */
export function configDocumentIssues(
  configSchema: PluginConfigSchemaService,
  target: Omit<PluginConfigValidationInput, 'config'>,
  document: unknown,
): readonly PluginConfigIssue[] {
  configSchema.assertUsable(target);

  if (!isPlainJsonObject(document)) {
    return [{ path: '', keyword: 'type', message: 'retained configuration is not a JSON object' }];
  }

  return configSchema.validate({ ...target, config: document });
}

/**
 * The runtime's half of the dormancy rule and the manifest bound (#577,
 * #1151): what `@bge/database` needs from one re-validated active manifest.
 * Built here because only the runtime can re-validate a manifest and compile
 * its config schema; the readers that consume it cannot import the runtime.
 *
 * `judgeConfig` is {@link configDocumentIssues} as a verdict: an unusable
 * schema answers `'schema-unusable'` whatever the document is, since it says
 * nothing about the document, and the rule reads it as `unavailable`, which
 * outranks `needs_configuration`.
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
        return configDocumentIssues(configSchema, target, document).length === 0 ? 'conforms' : 'rejected';
      } catch (error) {
        if (error instanceof PluginConfigSchemaUnusableError) {
          return 'schema-unusable';
        }

        throw error;
      }
    },
  };
}
