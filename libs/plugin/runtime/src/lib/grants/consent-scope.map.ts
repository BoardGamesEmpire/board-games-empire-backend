import { PluginGrantScope } from '@bge/database';
import type { PluginConsentScopeValue } from '@boardgamesempire/plugin-manifest';

/**
 * Manifest consent scope → grant scope: the manifest's consent vocabulary
 * pinned to the Prisma enum, same bridging role as the maps in
 * `install/manifest-enum.maps.ts`. Shared by the consent write path
 * (scope coherence), the C3 update path's scope-move handling, and the #60
 * consent classification — its own module so consumers depend on the map,
 * not on the grant service that happens to also use it.
 */
export const CONSENT_SCOPE_TO_GRANT_SCOPE: Readonly<Record<PluginConsentScopeValue, PluginGrantScope>> = {
  server: PluginGrantScope.Server,
  household: PluginGrantScope.Household,
  user: PluginGrantScope.User,
};
