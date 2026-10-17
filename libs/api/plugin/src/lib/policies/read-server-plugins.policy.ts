import { Action, ResourceType } from '@bge/database';
import type { AppAbility } from '@bge/permissions';

/**
 * The gate on the server's own plugin reads: the server list, the detail
 * read, the server consent surface, the staged update and the server feature
 * state. They serve provenance, install history and consent topology.
 *
 * A bare `can(read, Plugin)` would not keep users out. A type check passes on
 * any rule whatever its conditions, and every user holds
 * `read:plugin:installed`, the ceiling the unit lists compose against. That
 * grant is limited to the identity columns, so asking about a column it leaves
 * out is what tells it apart. `installedAt` is one: only the server reads
 * serve it. `read:plugin` and staff's wildcard carry no field list and pass,
 * and so does an API key's rule pinned to one plugin's id.
 *
 * An API key's rules carry no field list at all, whatever its slugs, so for a
 * key this gate checks its owner: PoliciesGuard asks every ability, and a
 * plain user's key is refused because its owner is. A staff member's key
 * passes on any `Plugin` slug, as its owner would.
 */
export const canReadServerPlugins = (ability: AppAbility): boolean =>
  ability.can(Action.read, ResourceType.Plugin, 'installedAt');
