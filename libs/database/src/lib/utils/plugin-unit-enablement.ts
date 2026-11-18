import type { Prisma, PrismaClient } from '../client';
import type { PluginActiveManifest } from './plugin-active-manifest-reader';
import type { PluginUnitCoordinates } from './plugin-grant.constants';

/**
 * A unit's enablement state for one plugin, components preserved (feature
 * state reports them separately).
 *
 * Dormancy is not a component: it is worked out from the active manifest and
 * `retainedConfig` by {@link derivePluginUnitDormancy} (#1151), which the
 * caller runs with the manifest it reads.
 *
 * Consent is not a component either: a unit that still owes a required
 * permission keeps serving on the grants it gave, and the ability denies what
 * it has not granted (#1149; removes #1061, #1063, #1147). "Consented" is
 * answered by `PluginConsentStandingService` in `@bge/plugin`, not here.
 */
export interface PluginUnitEnablement {
  /** A unit enablement exists for `(unit, pluginId)`. Always `true` for Server units, which have none to store. */
  readonly anchored: boolean;
  readonly enabled: boolean;
  /**
   * The document {@link derivePluginUnitDormancy} judges (#1151): a household
   * unit enablement's `config` exactly as stored (a stored JSON `null`
   * included, which the rule rejects), and `{}` for a household with no unit
   * enablement. `null` for Server and User units, whose configuration the
   * rule never judges.
   */
  readonly retainedConfig: Prisma.JsonValue | null;
}

/** The two state codes a dormant unit reports (#1151): a subset of the unit state codes the runtime reports. */
export const PLUGIN_UNIT_DORMANCY_CODES = ['unavailable', 'needs_configuration'] as const;
export type PluginUnitDormancy = (typeof PLUGIN_UNIT_DORMANCY_CODES)[number];

/**
 * Whether a unit is dormant, worked out from the active manifest and the
 * unit's retained document rather than stored (#1151): `'unavailable'` when
 * the unit cannot run whatever its document says, `'needs_configuration'`
 * when a household's document is what the schema rejects, `null` otherwise.
 *
 * - Any unit is `'unavailable'` when the stored manifest cannot be read.
 * - Server and User units are never judged on configuration: the server axis
 *   has no unit enablement (#697), and per-user configuration belongs to #228.
 * - A household unit is `'unavailable'` when the manifest has no household
 *   surface, tested before the document so a server-scope plugin's schema is
 *   never compiled for a household, and when the config schema cannot be used.
 *
 * Pure, and in this lib so every reader of "served" calls the same rule: the
 * reader side cannot import the runtime, which supplies the manifest through
 * {@link PluginActiveManifest}.
 */
export function derivePluginUnitDormancy(input: {
  /** `null` when the stored manifest cannot be read. */
  readonly manifest: PluginActiveManifest | null;
  /** A household unit's document, `{}` when it has no unit enablement. Ignored for Server and User units. */
  readonly retainedConfig: unknown;
  readonly scopeType: PluginUnitCoordinates['scopeType'];
}): PluginUnitDormancy | null {
  const { scopeType, manifest, retainedConfig } = input;

  switch (scopeType) {
    case 'Server':
    case 'User':
      return manifest === null ? 'unavailable' : null;

    case 'Household': {
      if (manifest === null || !manifest.householdSurface) {
        return 'unavailable';
      }

      const verdict = manifest.judgeConfig(retainedConfig);

      switch (verdict) {
        case 'schema-unusable':
          return 'unavailable';
        case 'rejected':
          return 'needs_configuration';
        case 'conforms':
          return null;
        default:
          throw new RangeError(`Unhandled plugin config verdict: ${JSON.stringify(verdict)}`);
      }
    }

    default:
      throw new RangeError(`Unhandled plugin unit scope type: ${JSON.stringify(scopeType)}`);
  }
}

/**
 * The document a household unit holds, which {@link derivePluginUnitDormancy}
 * judges as `retainedConfig` (#1151): the unit enablement's `config` exactly
 * as stored, and `{}` when the household has no unit enablement, since a new
 * one is created holding `{}`.
 *
 * Never write it as `row?.config ?? {}`: `config` is a Json column, and a
 * stored JSON `null` is a document the rule rejects, which `??` would read as
 * the empty one.
 */
export function retainedConfigOf(row: { readonly config: Prisma.JsonValue } | null | undefined): Prisma.JsonValue {
  return row === null || row === undefined ? {} : row.config;
}

/**
 * The plugin half of the serving predicate: the plugin is enabled and not
 * uninstalled. Shared by the plugin ability read (#60) and the permission
 * catalog's count of the consent decisions an edit affects (#772), so the two
 * cannot disagree on which plugins serve.
 */
export function isPluginServing(plugin: { readonly enabled: boolean; readonly uninstalledAt: Date | null }): boolean {
  return plugin.enabled && plugin.uninstalledAt === null;
}

/**
 * The unit half of the serving predicate collapsed to a boolean: the unit is
 * switched on and {@link derivePluginUnitDormancy} finds no dormancy in it
 * (#1151). Dormancy is independent of the switch: a household's switch
 * survives a scope narrowing or a schema tightening, so a switched-on unit can
 * still serve nothing. Consent is not a component (#1149). Shared for the
 * reason {@link isPluginServing} is.
 */
export function isPluginUnitServed(
  state: Pick<PluginUnitEnablement, 'enabled'>,
  dormancy: PluginUnitDormancy | null,
): boolean {
  return state.enabled && dormancy === null;
}

/**
 * The unit half of the serving predicate (#225): the
 * `HouseholdPlugin`/`UserPlugin` enablement for `(unit, pluginId)`, with a
 * missing one reading as not anchored and not enabled — for these scopes the
 * enablement IS the unit's participation. Server units have no unit
 * enablement; the plugin-level predicate (enabled, not uninstalled) is the
 * caller's half.
 *
 * Shared between the ability read path's serving predicate (#60,
 * `PermissionsService`) and the feature-state derivation for the same
 * reason `grantScopeCoordinatesForUnit` lives here: the two surfaces must
 * agree on what "served" means, and the reader side cannot import the
 * runtime. Callers work out the unit's dormancy with
 * {@link derivePluginUnitDormancy} and collapse both to a boolean with
 * {@link isPluginUnitServed}, or report the components separately.
 */
export async function loadPluginUnitEnablement(
  db: Pick<PrismaClient, 'householdPlugin' | 'userPlugin'>,
  pluginId: string,
  unit: PluginUnitCoordinates,
): Promise<PluginUnitEnablement> {
  switch (unit.scopeType) {
    case 'Server':
      return { anchored: true, enabled: true, retainedConfig: null };

    case 'Household': {
      const row = await db.householdPlugin.findUnique({
        where: { householdId_pluginId: { householdId: unit.householdId, pluginId } },
        select: { enabled: true, config: true },
      });

      return {
        anchored: row !== null,
        enabled: row?.enabled ?? false,
        retainedConfig: retainedConfigOf(row),
      };
    }

    case 'User': {
      const row = await db.userPlugin.findUnique({
        where: { userId_pluginId: { userId: unit.userId, pluginId } },
        select: { enabled: true },
      });

      // Per-user configuration belongs to #228, so the rule judges no document here.
      return {
        anchored: row !== null,
        enabled: row?.enabled ?? false,
        retainedConfig: null,
      };
    }

    default:
      throw new RangeError(`Unhandled plugin unit scope type: ${JSON.stringify(unit)}`);
  }
}
