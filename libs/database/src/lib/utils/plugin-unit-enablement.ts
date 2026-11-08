import type { PluginUnitDormantReason, PrismaClient } from '../client';
import type { PluginUnitCoordinates } from './plugin-grant.constants';

/**
 * A unit's enablement state for one plugin, components preserved (feature
 * state reports them separately).
 *
 * Consent is not a component: a unit that still owes a required permission
 * keeps serving on the grants it gave, and the ability denies what it has not
 * granted (#1149; removes #1061, #1063, #1147). "Consented" is answered by
 * `PluginConsentStandingService` in `@bge/plugin`, not here.
 */
export interface PluginUnitEnablement {
  /** A unit enablement exists for `(unit, pluginId)`. Always `true` for Server units, which have none to store. */
  readonly anchored: boolean;
  readonly enabled: boolean;
  /**
   * Non-null when the unit enablement is retained but cannot legitimately
   * serve (#369, #370): the plugin's scope no longer admits household
   * enablement, or the retained config no longer satisfies the active schema.
   * Always `null` for Server and User units — the server axis has no unit
   * enablement, and the user axis has no dormancy: user consent is legal at
   * any plugin scope (#225), and per-user config belongs to #228.
   */
  readonly dormantReason: PluginUnitDormantReason | null;
}

/**
 * The unit half of the serving predicate (#225): the
 * `HouseholdPlugin`/`UserPlugin` enablement for `(unit, pluginId)`, with a
 * missing one reading as not anchored and not enabled — for these scopes the
 * enablement IS the unit's participation. Server units have no unit
 * enablement; the plugin-level predicate (enabled, not tombstoned) is the
 * caller's half.
 *
 * Shared between the ability read path's serving predicate (#60,
 * `PermissionsService`) and the feature-state derivation for the same
 * reason `grantScopeCoordinatesForUnit` lives here: the two surfaces must
 * agree on what "served" means, and the reader side cannot import the
 * runtime. Callers collapse to a boolean
 * (`enabled && dormantReason === null`) or report the components separately.
 */
export async function loadPluginUnitEnablement(
  db: Pick<PrismaClient, 'householdPlugin' | 'userPlugin'>,
  pluginId: string,
  unit: PluginUnitCoordinates,
): Promise<PluginUnitEnablement> {
  switch (unit.scopeType) {
    case 'Server':
      return { anchored: true, enabled: true, dormantReason: null };

    case 'Household': {
      const row = await db.householdPlugin.findUnique({
        where: { householdId_pluginId: { householdId: unit.householdId, pluginId } },
        select: { enabled: true, dormantReason: true },
      });

      return {
        anchored: row !== null,
        enabled: row?.enabled ?? false,
        dormantReason: row?.dormantReason ?? null,
      };
    }

    case 'User': {
      const row = await db.userPlugin.findUnique({
        where: { userId_pluginId: { userId: unit.userId, pluginId } },
        select: { enabled: true },
      });

      // No dormancy on this axis — see PluginUnitEnablement.dormantReason.
      return {
        anchored: row !== null,
        enabled: row?.enabled ?? false,
        dormantReason: null,
      };
    }

    default:
      throw new RangeError(`Unhandled plugin unit scope type: ${JSON.stringify(unit)}`);
  }
}
