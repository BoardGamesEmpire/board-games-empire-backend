import { PluginGrantScope } from '../client';

/**
 * `PluginGrant.scope_id` value for Server-scope rows. The column is
 * non-nullable so the `(pluginId, scopeType, scopeId, permissionSlug)`
 * unique holds as a plain quadruple (Postgres treats NULLs as distinct in
 * unique indexes); the schema's CHECK constraint enforces that Server rows
 * carry exactly this sentinel and unit-scoped rows never do.
 *
 * Shared from here because both writers (the runtime's grant/install/update
 * services) and readers (the permissions lib's ability resolution, #60)
 * must agree on the at-rest form, and the reader side cannot import the
 * runtime.
 */
export const SERVER_SCOPE_SENTINEL = '' as const;

/**
 * Structural mirror of `@bge/actor-context`'s `PluginUnit` — this lib sits
 * beneath actor-context and cannot import it, and the scope-type strings
 * are pinned to the `PluginGrantScope` enum values on both sides. The real
 * union is assignable to this shape, and mirroring the discrimination keeps
 * the coordinate reads below cast-free.
 */
export type PluginUnitCoordinates =
  | { readonly scopeType: 'Server'; readonly householdId?: undefined; readonly userId?: undefined }
  | { readonly scopeType: 'Household'; readonly householdId: string; readonly userId?: undefined }
  | { readonly scopeType: 'User'; readonly userId: string; readonly householdId?: undefined };

/**
 * The grant-row scope filters a unit's resolution reads (#60): the
 * Server sentinel always (server grants are the plugin's global authority),
 * plus the unit's own coordinates. Never widened past the operating unit —
 * a household-unit read must not see another household's rows — and shared
 * between the ability read path and the feature-state derivation so the
 * two can never disagree about what a unit consumes.
 */
export function grantScopeCoordinatesForUnit(
  unit: PluginUnitCoordinates,
): { scopeType: PluginGrantScope; scopeId: string }[] {
  const serverScope = { scopeType: PluginGrantScope.Server, scopeId: SERVER_SCOPE_SENTINEL };

  switch (unit.scopeType) {
    case 'Server':
      return [serverScope];
    case 'Household':
      return [serverScope, { scopeType: PluginGrantScope.Household, scopeId: unit.householdId }];
    case 'User':
      return [serverScope, { scopeType: PluginGrantScope.User, scopeId: unit.userId }];
    default:
      throw new RangeError(`Unhandled plugin unit scope type: ${JSON.stringify(unit)}`);
  }
}
