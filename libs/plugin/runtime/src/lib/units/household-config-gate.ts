import type { HouseholdPlugin, Plugin, Prisma } from '@bge/database';
import { PluginUnitDormantReason } from '@bge/database';
import type { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { PluginUnitConfigRequiredError } from './unit.errors';

/**
 * The household configuration gate, shared by the two writers that switch a
 * household unit on: `PluginUnitLifecycleService.enableHousehold` and a
 * consent act's switch-on (#1150). One copy, so the two cannot disagree about
 * what puts a unit back into service.
 */

/**
 * The unsupplied-config half of the enable gate: a retained row config
 * must satisfy the ACTIVE schema, or the enable is refused with the
 * retained document's violations — never silently enabled over config
 * an update or reinstall left stale.
 */
export function assertRetainedConfigSatisfiesGate(
  configSchema: PluginConfigSchemaService,
  plugin: Pick<Plugin, 'slug' | 'version'>,
  schema: Record<string, unknown>,
  existing: HouseholdPlugin | null,
): void {
  if (existing === null) {
    throw new PluginUnitConfigRequiredError(plugin.slug, []);
  }

  // `config` is a Json column, so its Prisma type admits arrays, `null` and
  // scalars — shapes a permissive schema like `{}` accepts and that a bare
  // `as Record<string, unknown>` would wave through as an object. No API path
  // can store one today (both config DTOs are `@IsObject`, which rejects
  // arrays and null, and every writer of this column takes its value from
  // them), so this guards the cast rather than a reachable state. It is here
  // because it is the same judgment `configConforms` makes during
  // reconciliation, and the two cannot be allowed to disagree about what a
  // valid retained document is: that pass condemns the row, and this gate is
  // what puts it back into service.
  const retained = existing.config;

  if (typeof retained !== 'object' || retained === null || Array.isArray(retained)) {
    throw new PluginUnitConfigRequiredError(plugin.slug, [
      { path: '', keyword: 'type', message: 'retained configuration is not a JSON object' },
    ]);
  }

  const issues = configSchema.validate({
    slug: plugin.slug,
    version: plugin.version,
    schema,
    config: retained,
  });

  if (issues.length > 0) {
    throw new PluginUnitConfigRequiredError(plugin.slug, issues);
  }
}

/**
 * The dormancy half of a household write that has just validated a document
 * against the ACTIVE schema: the document that made the row dormant is gone,
 * so the dormancy is over (#370).
 *
 * Narrowed to `NeedsConfiguration` — the only reason a config write can cure.
 * A `ScopeOrphaned` row never reaches either caller anyway (both require the
 * household surface), and clearing it here would put a row back into service
 * on a scope that has no household axis.
 */
export function configDormancyCleared(
  existing: HouseholdPlugin,
): Pick<Prisma.HouseholdPluginUpdateInput, 'dormantReason' | 'dormantAt'> {
  return existing.dormantReason === PluginUnitDormantReason.NeedsConfiguration
    ? { dormantReason: null, dormantAt: null }
    : {};
}
