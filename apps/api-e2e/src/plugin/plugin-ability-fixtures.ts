import {
  PluginGrantScope,
  type DatabaseService,
  type PluginRequestedPermissionsReader,
  type PrismaClient,
} from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import {
  PluginManifestValidationError,
  validatePluginManifest,
  type PluginConsentScopeValue,
} from '@boardgamesempire/plugin-manifest';

/**
 * The consent scope a manifest names, as the decision scope a grant row
 * carries. The runtime's own map lives in `@bge/plugin`, which this project
 * does not depend on; the three entries are the whole of it.
 */
const GRANT_SCOPE: Readonly<Record<PluginConsentScopeValue, PluginGrantScope>> = {
  server: PluginGrantScope.Server,
  household: PluginGrantScope.Household,
  user: PluginGrantScope.User,
};

/**
 * The runtime's requested-permissions reader, as a spec can build it: the
 * stored manifest validated again, and each requested permission at its
 * decision scope (#577). Without a reader the snapshot confers nothing at all,
 * so a spec asserting that a decision does NOT confer would pass for the wrong
 * reason; each spec using it therefore also asserts a decision that does.
 * Unlike the runtime's reader, it skips the check that the manifest's slug and
 * version agree with the plugin row.
 */
const requestedPermissionsReader: PluginRequestedPermissionsReader = {
  read(row) {
    try {
      const validated = validatePluginManifest(row.manifestJson, {
        bgeVersion: '0.0.0',
        defaultLocale: 'en',
        enforceBgeCompat: false,
      });

      return {
        valid: true,
        requested: validated.permissionChecks.map((check) => ({
          slug: check.canonicalSlug,
          scopeType: GRANT_SCOPE[check.consentScope],
        })),
      };
    } catch (error) {
      // Only a failed validation is an answer, as in the runtime's reader;
      // anything else is a broken fixture and fails the test loudly.
      if (error instanceof PluginManifestValidationError) {
        return { valid: false, detail: error.message };
      }

      throw error;
    }
  },
};

/**
 * The core permissions a plugin's ability holds for one household, as
 * `PermissionsService.getPluginGrantSnapshot` resolves them from the rows
 * (#1150). The snapshot read touches neither cache, so the service runs here
 * over the spec's own client.
 */
export async function pluginAbilitySlugsForHousehold(
  client: PrismaClient,
  pluginId: string,
  householdId: string,
): Promise<string[]> {
  const service = new PermissionsService(
    client as unknown as DatabaseService,
    {} as never,
    {} as never,
    requestedPermissionsReader,
  );
  const snapshot = await service.getPluginGrantSnapshot(pluginId, { scopeType: 'Household', householdId });

  return (snapshot?.corePermissions ?? []).map((permission) => permission.slug).sort();
}
