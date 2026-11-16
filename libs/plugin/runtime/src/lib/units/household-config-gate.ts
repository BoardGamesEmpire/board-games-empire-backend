import type { HouseholdPlugin, Plugin } from '@bge/database';
import type { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { isPlainJsonObject } from '../is-plain-json-object';
import { PluginUnitConfigRequiredError } from './unit.errors';

/**
 * The household configuration gate (#323, #1151). A household unit's dormancy
 * is worked out when read, from the document its unit enablement holds, and a
 * document the active config schema rejects reads as `needs_configuration`. A
 * consent act's switch-on that supplies no document runs this gate, so a
 * switch-on never leaves a unit switched on over a document the read would
 * call `needs_configuration`.
 */

/**
 * The document a household unit would hold after a switch-on that supplies
 * none must satisfy the active schema. Throws PluginUnitConfigRequiredError.
 *
 * That document is the unit enablement's `config`, or `{}` when the household
 * has none, since a new unit enablement is created holding `{}`.
 *
 * The schema's usability is established first, as `judgeConfig` does, because
 * a schema that cannot be used reads `unavailable`, which outranks
 * `needs_configuration` and which no configuration the admin supplies cures,
 * so it throws PluginConfigSchemaUnusableError whatever the document is.
 */
export function assertHeldConfigSatisfiesGate(
  configSchema: PluginConfigSchemaService,
  plugin: Pick<Plugin, 'slug' | 'version'>,
  activeConfig: { readonly schema: Record<string, unknown>; readonly requiresHouseholdConfig: boolean },
  existing: HouseholdPlugin | null,
): void {
  configSchema.assertUsable({ slug: plugin.slug, version: plugin.version, schema: activeConfig.schema });

  if (existing === null && activeConfig.requiresHouseholdConfig) {
    throw new PluginUnitConfigRequiredError(plugin.slug, []);
  }

  // Not `existing?.config ?? {}`: `config` is a Json column, and a stored JSON
  // `null` is a document the read rejects, which `??` would judge as `{}`.
  const held: unknown = existing === null ? {} : existing.config;

  // A Json column admits arrays, `null` and scalars, and a permissive schema
  // such as `{}` accepts every one of them. The read's `judgeConfig` rejects
  // any document that is not a plain object before it consults the schema;
  // this gate makes the same judgment, so the two cannot disagree about which
  // documents a switched-on unit can serve with.
  if (!isPlainJsonObject(held)) {
    throw new PluginUnitConfigRequiredError(plugin.slug, [
      { path: '', keyword: 'type', message: 'retained configuration is not a JSON object' },
    ]);
  }

  const issues = configSchema.validate({
    slug: plugin.slug,
    version: plugin.version,
    schema: activeConfig.schema,
    config: held,
  });

  if (issues.length > 0) {
    throw new PluginUnitConfigRequiredError(plugin.slug, issues);
  }
}
