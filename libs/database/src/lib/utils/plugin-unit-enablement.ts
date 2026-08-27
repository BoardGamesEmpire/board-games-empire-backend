import type { PluginUnitDormantReason, PrismaClient } from '../client';
import type { PluginUnitCoordinates } from './plugin-grant.constants';

/** A unit's enablement-row state for one plugin, components preserved (feature-state reports them separately). */
export interface PluginUnitEnablement {
  readonly enabled: boolean;
  readonly suspendedForConsent: boolean;
  /**
   * Non-null when the row is retained but cannot legitimately serve (#369,
   * #370, D-CK): the plugin's scope no longer admits household enablement, or
   * the retained config no longer satisfies the active schema. Always `null`
   * for Server and User units — the server axis has no enablement row, and the
   * user axis has no dormancy: user consent is legal at any plugin scope
   * (#225), and per-user config belongs to #228.
   */
  readonly dormantReason: PluginUnitDormantReason | null;
}

/**
 * The unit half of the serving predicate (#225): the
 * `HouseholdPlugin`/`UserPlugin` enablement row for `(unit, pluginId)`,
 * with a missing row reading as not enabled — for these scopes the row IS
 * the unit's participation. Server units have no enablement row; the
 * plugin-level predicate (enabled, not tombstoned) is the caller's half.
 *
 * Shared between the ability read path's serving predicate (#60,
 * `PermissionsService`) and the feature-state derivation for the same
 * reason `grantScopeCoordinatesForUnit` lives here: the two surfaces must
 * agree on what "served" means, and the reader side cannot import the
 * runtime. Callers collapse to a boolean
 * (`enabled && !suspendedForConsent && dormantReason === null`) or report the
 * components separately.
 */
export async function loadPluginUnitEnablement(
  db: Pick<PrismaClient, 'householdPlugin' | 'userPlugin'>,
  pluginId: string,
  unit: PluginUnitCoordinates,
): Promise<PluginUnitEnablement> {
  switch (unit.scopeType) {
    case 'Server':
      return { enabled: true, suspendedForConsent: false, dormantReason: null };

    case 'Household': {
      const row = await db.householdPlugin.findUnique({
        where: { householdId_pluginId: { householdId: unit.householdId, pluginId } },
        select: { enabled: true, suspendedForConsent: true, dormantReason: true },
      });

      return {
        enabled: row?.enabled ?? false,
        suspendedForConsent: row?.suspendedForConsent ?? false,
        dormantReason: row?.dormantReason ?? null,
      };
    }

    case 'User': {
      const row = await db.userPlugin.findUnique({
        where: { userId_pluginId: { userId: unit.userId, pluginId } },
        select: { enabled: true, suspendedForConsent: true },
      });

      // No dormancy on this axis — see PluginUnitEnablement.dormantReason.
      return {
        enabled: row?.enabled ?? false,
        suspendedForConsent: row?.suspendedForConsent ?? false,
        dormantReason: null,
      };
    }

    default:
      throw new RangeError(`Unhandled plugin unit scope type: ${JSON.stringify(unit)}`);
  }
}
