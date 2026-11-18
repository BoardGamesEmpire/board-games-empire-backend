import type { HouseholdPlugin } from '@bge/database';
import { derivePluginUnitDormancy, retainedConfigOf } from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { PluginConfigSchemaUnusableError } from '../config/config-schema.errors';
import type { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { MANIFEST_SCOPE_TO_PRISMA } from '../install/manifest-enum.maps';
import { activeManifestOf, configDocumentIssues } from '../manifest/active-manifest';
import { PluginUnitConfigRequiredError, PluginUnitScopeError } from './unit.errors';

/**
 * The household configuration gate (#323, #1151). A household unit's dormancy
 * is worked out when read, by `derivePluginUnitDormancy`, from the active
 * manifest and the document its unit enablement holds. A consent act's
 * switch-on that supplies no document asks the same rule about the document
 * it would leave the unit holding, so a switch-on never leaves a unit switched
 * on in a state the read calls dormant.
 */

/**
 * Refuses a household switch-on that supplies no document when the rule finds
 * the unit dormant, with the typed error for the rule's cause. Never returns
 * normally when the rule answers non-null.
 *
 * The document is the unit enablement's `config`, or `{}` when the household
 * has none. Where two refusals apply, the order is:
 *
 * 1. `unavailable`, which no configuration cures: PluginUnitScopeError when
 *    the manifest has no household surface, PluginConfigSchemaUnusableError
 *    when its config schema cannot be used.
 * 2. A first switch-on the manifest requires a document for
 *    (`requiresHouseholdConfig`): PluginUnitConfigRequiredError with no
 *    issues, whatever the rule says about `{}`.
 * 3. `needs_configuration`: PluginUnitConfigRequiredError with the
 *    violations.
 */
export function assertHeldConfigSatisfiesGate(
  configSchema: PluginConfigSchemaService,
  active: PluginManifestValidationResult,
  existing: HouseholdPlugin | null,
): void {
  const { manifest } = active;
  const target = { slug: manifest.slug, version: manifest.version, schema: manifest.config.schema };
  const retainedConfig = retainedConfigOf(existing);
  const activeManifest = activeManifestOf(active, configSchema);
  const dormancy = derivePluginUnitDormancy({ scopeType: 'Household', manifest: activeManifest, retainedConfig });

  if (dormancy === 'unavailable') {
    // Built as `assertHouseholdSurface` builds it from the plugin's `scope`
    // column, so the refusal reads the same from either source.
    if (!activeManifest.householdSurface) {
      throw new PluginUnitScopeError(manifest.slug, MANIFEST_SCOPE_TO_PRISMA[manifest.scope].toLowerCase());
    }

    // With a household surface, the rule reads `unavailable` only for a
    // config schema that cannot be used; establishing it again throws the
    // typed error with the compiler's reason.
    configSchema.assertUsable(target);

    throw new PluginConfigSchemaUnusableError(manifest.slug, manifest.version, 'the config schema cannot be used');
  }

  if (existing === null && manifest.config.requiresHouseholdConfig) {
    throw new PluginUnitConfigRequiredError(manifest.slug, []);
  }

  if (dormancy === 'needs_configuration') {
    throw new PluginUnitConfigRequiredError(manifest.slug, configDocumentIssues(configSchema, target, retainedConfig));
  }

  // Every dormancy refuses above, so only null reaches here. A new dormancy
  // value fails to compile on this line until the gate decides how to refuse
  // it (#1151).
  dormancy satisfies null;
}
