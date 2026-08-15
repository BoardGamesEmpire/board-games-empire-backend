import type { PrismaClient } from '../client';
import type { PluginUnitCoordinates } from './plugin-grant.constants';

/** A unit's enablement-row state for one plugin, components preserved (feature-state reports them separately). */
export interface PluginUnitEnablement {
  readonly enabled: boolean;
  readonly suspendedForConsent: boolean;
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
 * runtime. Callers collapse to a boolean (`enabled && !suspendedForConsent`)
 * or report the components separately.
 */
export async function loadPluginUnitEnablement(
  db: Pick<PrismaClient, 'householdPlugin' | 'userPlugin'>,
  pluginId: string,
  unit: PluginUnitCoordinates,
): Promise<PluginUnitEnablement> {
  switch (unit.scopeType) {
    case 'Server':
      return { enabled: true, suspendedForConsent: false };

    case 'Household': {
      const row = await db.householdPlugin.findUnique({
        where: { householdId_pluginId: { householdId: unit.householdId, pluginId } },
        select: { enabled: true, suspendedForConsent: true },
      });

      return { enabled: row?.enabled ?? false, suspendedForConsent: row?.suspendedForConsent ?? false };
    }

    case 'User': {
      const row = await db.userPlugin.findUnique({
        where: { userId_pluginId: { userId: unit.userId, pluginId } },
        select: { enabled: true, suspendedForConsent: true },
      });

      return { enabled: row?.enabled ?? false, suspendedForConsent: row?.suspendedForConsent ?? false };
    }

    default:
      throw new RangeError(`Unhandled plugin unit scope type: ${JSON.stringify(unit)}`);
  }
}
